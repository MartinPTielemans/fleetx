/**
 * Making an always-on machine the fleet's hub (its relay, and later its MCP
 * hub), from the authority the setup wizard runs on. The hub's own side, over
 * ssh, is Remote.ts; this is everything the authority does for it, through
 * the paths `t3-fleet invite`, `t3-fleet secrets add-node` and
 * `t3-fleet approve` take:
 *
 *   admit    nodes/<hub>.toml (roles member and relay, its ssh destination),
 *            [relay] in t3-fleet.toml, a relay token among the secrets, and
 *            [ui] allow with this machine's Tailscale login, so the app the
 *            hub hosts opens for whoever set it up; committed and pushed, so
 *            the hub's setup finds itself in the fleet
 *   join     Remote.bringUpHub: T3 Fleet installed there, `t3-fleet setup`
 *            joining the fleet as that node
 *   key      the hub's public key added as a recipient of the secrets, so it
 *            reads the relay token
 *   approve  the hub's proposal, when it only touches the hub's own files;
 *            anything more waits for review like any proposal
 *   sync     a sync on the hub, so it reads the secrets and starts the relay
 *            now rather than on its timer
 *
 * Every step can run again over its own half-done work. What was asked for is
 * kept in ~/.local/state/t3-fleet/setup/hub.json until the hub is up, so a
 * bring-up that failed is retried (the wizard's resume) rather than forgotten.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProbeServices } from "../Area.ts";
import { loadConfig, type Config } from "../Config.ts";
import { exec } from "../Exec.ts";
import { commitAndPush, git, out } from "../Git.ts";
import { randomBytes } from "../hub/Policy.ts";
import { FLEET_FILE, stateDir } from "../Names.ts";
import { TAILSCALE_APP } from "../areas/RelayArea.ts";
import { RELAY_TOKEN } from "../RelayClient.ts";
import {
  addRecipient,
  installSecrets,
  readSecrets,
  SECRETS_FILES,
  setVar,
  varNames,
  writeSecrets,
} from "../Secrets.ts";
import { approve, listProposals } from "../Staging.ts";
import { underSyncLock } from "../SyncLock.ts";
import { relayEdits, rolesOf } from "./Apply.ts";
import { PROPOSED_SECRETS } from "./Plan.ts";
import { bringUpHub } from "./Remote.ts";
import { newNodeFile } from "./Repo.ts";
import { setKey, type Edit } from "./TomlEdit.ts";

/** A hub asked for, until it is up. */
export const HubRequest = Schema.Struct({
  node: Schema.String,
  ssh: Schema.String,
  relayUrl: Schema.NullOr(Schema.String),
  /** Why the last bring-up stopped; null before the first, or while one runs. */
  error: Schema.NullOr(Schema.String),
});
export type HubRequest = typeof HubRequest.Type;

export const hubPath = (home: string) => `${stateDir(home)}/setup/hub.json`;

export const readHub = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(hubPath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<HubRequest>();
    return Schema.decodeOption(Schema.fromJsonString(HubRequest))(text.value);
  });

export const writeHub = (home: string, hub: HubRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${stateDir(home)}/setup`, { recursive: true });
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(HubRequest))(hub);
    yield* fs.writeFileString(hubPath(home), `${text}\n`, { mode: 0o600 });
  });

export const dropHub = (home: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(hubPath(home), { force: true })),
    Effect.ignore,
  );

/** What bringing the hub up does, in plain words, for the plan. */
export const hubStepTitles = (hub: { readonly node: string }) => [
  `Add ${hub.node} to the fleet as its relay, with a new relay token among the secrets, and let your Tailscale login open the app it hosts`,
  `Install T3 Fleet on ${hub.node} and join it to the fleet, over ssh`,
  `Let ${hub.node} read the fleet's secrets`,
  `Approve ${hub.node}'s proposal when it only touches its own files`,
  `Sync ${hub.node}, so it starts the relay`,
];

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Apply edits to a TOML text, or fail with why. */
const edited = (file: string, text: string, steps: ReadonlyArray<(t: string) => Edit>) =>
  Effect.gen(function* () {
    let current = text;
    for (const step of steps) {
      const edit = step(current);
      if ("error" in edit) return yield* Effect.fail(`${file}: ${edit.error}`);
      current = edit.text;
    }
    return current;
  });

const TailscaleStatus = Schema.fromJsonString(
  Schema.Struct({
    Self: Schema.Struct({ UserID: Schema.Number }),
    User: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ LoginName: Schema.String })),
    ),
  }),
);

/** The login in `tailscale status --json`'s output; null when it names none. */
export const loginOfStatus = (json: string) =>
  Option.match(Schema.decodeUnknownOption(TailscaleStatus)(json), {
    onNone: () => null,
    onSome: (s) => s.User?.[String(s.Self.UserID)]?.LoginName ?? null,
  });

/** The Tailscale login this machine is signed in as; null without Tailscale, or signed out. */
export const tailscaleLogin = Effect.gen(function* () {
  for (const command of ["tailscale", TAILSCALE_APP]) {
    const status = yield* exec({
      command,
      args: ["status", "--json", "--peers=false"],
      timeout: Duration.seconds(10),
    });
    if (status.code === 0) return loginOfStatus(status.stdout);
  }
  return null;
});

/**
 * The hub in the repo: its node file, [relay], the relay token, and `owner`
 * (this machine's Tailscale login) as the one login the app on the hub opens
 * for. Only what is missing is written; committed and pushed in one commit.
 */
export const admitHub = (config: Config, hub: HubRequest, owner: string | null = null) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = config.repo;
      const lines: Array<string> = [];
      const nodeFile = `${repo}/nodes/${hub.node}.toml`;
      const nodeBefore = yield* fs
        .readFileString(nodeFile)
        .pipe(
          Effect.orElseSucceed(() => newNodeFile(hub.node, ["member", "relay"], "t3-fleet setup")),
        );
      const nodeAfter = yield* edited(`nodes/${hub.node}.toml`, nodeBefore, [
        (t) => {
          const roles = rolesOf(t);
          return roles.includes("relay")
            ? { text: t }
            : setKey(t, [], "roles", [...roles, "relay"]);
        },
        (t) => (/^ssh\s*=/m.test(t) ? { text: t } : setKey(t, [], "ssh", hub.ssh)),
      ]);
      if (nodeAfter !== nodeBefore || !(yield* fs.exists(nodeFile))) {
        yield* fs.writeFileString(nodeFile, nodeAfter);
        lines.push(`nodes/${hub.node}.toml: the relay, reached at ${hub.ssh}`);
      }
      const fleetFile = `${repo}/${FLEET_FILE}`;
      const fleetBefore = yield* fs.readFileString(fleetFile);
      if (!/^\[relay\]/m.test(fleetBefore)) {
        const after = yield* edited(FLEET_FILE, fleetBefore, [(t) => relayEdits(t, hub.relayUrl)]);
        yield* fs.writeFileString(fleetFile, after);
        lines.push(
          hub.relayUrl === null
            ? `[relay] in ${FLEET_FILE}; set its url once ${hub.node} can be reached`
            : `[relay] in ${FLEET_FILE}: ${hub.relayUrl}`,
        );
      }
      if (owner !== null) {
        const text = yield* fs.readFileString(fleetFile);
        if (config.settings.ui?.allow === undefined && !/^\[ui\]/m.test(text)) {
          const after = yield* edited(FLEET_FILE, text, [
            (t) => setKey(t, ["ui"], "allow", [owner]),
          ]);
          yield* fs.writeFileString(fleetFile, after);
          lines.push(`[ui] in ${FLEET_FILE}: the app on ${hub.node} opens for ${owner}`);
        }
      }
      const secrets = yield* readSecrets(repo);
      if (!varNames(secrets).includes(RELAY_TOKEN)) {
        yield* writeSecrets(repo, setVar(secrets, RELAY_TOKEN, hex(randomBytes(32))));
        yield* installSecrets(repo);
        lines.push(`a new ${RELAY_TOKEN}, encrypted among the secrets`);
      }
      const rev = yield* commitAndPush(
        repo,
        [`nodes/${hub.node}.toml`, FLEET_FILE, ...SECRETS_FILES],
        `Make ${hub.node} the relay`,
      );
      if (rev !== "nothing to commit") lines.push(`committed and pushed ${rev}`);
      return lines.length === 0 ? [`${hub.node} is in the fleet already`] : lines;
    }),
  );

const ssh = (destination: string, command: string, seconds: number) =>
  exec({
    command: "ssh",
    // A login shell: ~/.local/bin, where T3 Fleet lives, is on its PATH.
    args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", destination, `sh -lc '${command}'`],
    timeout: Duration.seconds(seconds),
  });

/** The hub's public key, from its own T3 Fleet (`t3-fleet secrets init` prints it, making one if needed). */
export const hubRecipient = (destination: string) =>
  Effect.gen(function* () {
    const result = yield* ssh(destination, "t3-fleet secrets init", 60);
    const key = /public: (age1[0-9a-z]+)/.exec(result.stdout)?.[1];
    if (result.code !== 0 || key === undefined)
      return yield* Effect.fail(
        `could not read ${destination}'s key: ${result.stderr.trim().split("\n").pop() ?? `exit ${result.code}`}`,
      );
    return key;
  });

/** Whether a proposal only touches the hub's own files: its node file and its proposed secrets. */
export const ownFilesOnly = (node: string, files: ReadonlyArray<string>) =>
  files.every((f) => f === `nodes/${node}.toml` || f === `${PROPOSED_SECRETS}/${node}.env.age`);

/** Bring the hub up: every step in order, each said through `step`. */
export const bringUp = (
  hub: HubRequest,
  step: (text: string) => Effect.Effect<void>,
): Effect.Effect<void, string, ProbeServices> =>
  Effect.gen(function* () {
    const message = (e: unknown) =>
      typeof e === "string"
        ? e
        : typeof e === "object" && e !== null && "message" in e
          ? String(e.message)
          : String(e);
    const config = yield* loadConfig.pipe(Effect.mapError(message));
    const [admit, join, key, review, sync] = hubStepTitles(hub);
    yield* step(admit ?? "");
    const owner = yield* tailscaleLogin;
    for (const line of yield* admitHub(config, hub, owner).pipe(Effect.mapError(message)))
      yield* step(`✓ ${line}`);

    yield* step(join ?? "");
    const repoUrl = out(yield* git(config.repo, ["remote", "get-url", "origin"]));
    if (repoUrl === "")
      return yield* Effect.fail("the fleet's repo has no remote, so the hub cannot clone it");
    yield* bringUpHub({
      ssh: hub.ssh,
      node: hub.node,
      repoUrl,
      relayUrl: hub.relayUrl,
      onStep: step,
    });

    yield* step(key ?? "");
    const recipient = yield* hubRecipient(hub.ssh);
    const added = yield* underSyncLock(
      addRecipient(config.repo, hub.node, recipient).pipe(
        Effect.flatMap((changed) =>
          changed
            ? commitAndPush(config.repo, SECRETS_FILES, `Let ${hub.node} read the fleet's secrets`)
            : Effect.succeed("nothing to commit"),
        ),
      ),
    ).pipe(Effect.mapError(message));
    yield* step(
      added === "nothing to commit"
        ? `✓ ${hub.node} can already read the secrets`
        : `✓ ${hub.node} can read the secrets (${added})`,
    );

    yield* step(review ?? "");
    const proposal = (yield* listProposals(config.repo, config.branch).pipe(
      Effect.mapError(message),
    )).find((p) => p.node === hub.node);
    if (proposal === undefined) yield* step(`✓ ${hub.node} proposed nothing`);
    else if (!ownFilesOnly(hub.node, proposal.files))
      yield* step(
        `${hub.node} proposed more than its own files (${proposal.files.join(", ")}); review it under Proposals`,
      );
    else {
      const approved = yield* approve(config.repo, config.branch, proposal, config.self).pipe(
        Effect.mapError(message),
      );
      yield* step(`✓ approved ${hub.node}'s proposal`);
      for (const note of approved.notes) yield* step(`✓ ${note}`);
    }

    yield* step(sync ?? "");
    const synced = yield* ssh(hub.ssh, "t3-fleet sync", 300);
    yield* step(
      synced.code === 0
        ? `✓ ${hub.node} synced`
        : `${hub.node}'s sync did not finish (${synced.stderr.trim().split("\n").pop() ?? `exit ${synced.code}`}); its timer tries again`,
    );
  });
