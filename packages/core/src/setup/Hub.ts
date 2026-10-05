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
 *            hub hosts opens for whoever set it up, and [defaults.mcp] hub
 *            and gateway when it hosts the MCP servers; committed and
 *            pushed, so the hub's setup finds itself in the fleet
 *   join     Remote.bringUpHub: T3 Fleet installed there, `t3-fleet setup`
 *            joining the fleet as that node
 *   key      the hub's public key added as a recipient of the secrets, so it
 *            reads the relay token
 *   approve  the hub's proposal, when it is exactly its own proposed secrets
 *            (onboardingOnly), bound to the commit checked; anything more
 *            (its node file included) waits for review like any proposal
 *   sync     a sync on the hub, so it reads the secrets and starts the relay
 *            now rather than on its timer
 *   mcp      when asked: [defaults.mcp] hub and gateway, only once that sync
 *            succeeded, so no machine's MCP servers move to a hub that is
 *            not up
 *
 * Every step that changes the fleet is an authority's: each refuses unless
 * this machine is one (requireAuthority), read again before it runs. An
 * abandoned bring-up takes out what admission added (undoAdmission).
 *
 * Every step can run again over its own half-done work. What was asked for is
 * kept in ~/.local/state/t3-fleet/setup/hub.json until the hub is up, so a
 * bring-up that failed is retried (the wizard's resume) rather than forgotten.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { ProbeServices } from "../Area.ts";
import { loadConfig, type Config } from "../Config.ts";
import { exec, type ExecResult } from "../Exec.ts";
import { changedFiles, commitAndPush, git, ok, out, pullBranch, restorePaths } from "../Git.ts";
import { removeNode } from "../leave/Fleet.ts";
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
import { syncRun } from "../Sync.ts";
import { underSyncLock, waitForSyncLock } from "../SyncLock.ts";
import {
  applyRelay,
  mcpHubEdits,
  movedLines,
  moveServersToHub,
  relayEdits,
  rolesOf,
} from "./Apply.ts";
import { PROPOSED_SECRETS } from "./Plan.ts";
import { hubStepTitles } from "./PlanWords.ts";
import { bringUpHub, hubMembership, membershipProblem } from "./Remote.ts";
import { newNodeFile } from "./Repo.ts";
import { dropKey, dropTable, setKey, type Edit } from "./TomlEdit.ts";

/** What admission added to the repo, so an abandoned bring-up can take it out again. */
export const Admitted = Schema.Struct({
  /** nodes/<hub>.toml was created by admission. */
  node: Schema.Boolean,
  /** [relay] in t3-fleet.toml. */
  relay: Schema.Boolean,
  /** [ui] allow. */
  ui: Schema.Boolean,
  /** The relay token among the secrets. */
  token: Schema.Boolean,
  /** `[ui] hosted = false`, added to a [ui] admission did not create. */
  hosted: Schema.optionalKey(Schema.Boolean),
});
export type Admitted = typeof Admitted.Type;

/** A hub asked for, until it is up. */
export const HubRequest = Schema.Struct({
  node: Schema.String,
  ssh: Schema.String,
  relayUrl: Schema.NullOr(Schema.String),
  /**
   * Host the fleet's MCP servers there ([defaults.mcp] hub, its gateway the
   * relay URL); absent in a hub.json written before this was asked.
   */
  mcp: Schema.optionalKey(Schema.Boolean),
  /**
   * false when the check of the hub said it cannot serve the fleet app
   * (UiProbe.app): admission writes `[ui] hosted = false`. Absent: it can, or
   * a hub.json written before this was asked.
   */
  hostsApp: Schema.optionalKey(Schema.Boolean),
  /** Why the last bring-up stopped; null before the first, or while one runs. */
  error: Schema.NullOr(Schema.String),
  /** What admission committed, once it has (an abandon takes it out again). */
  admitted: Schema.optionalKey(Admitted),
  /** The hub's key was added to the secrets' recipients by this bring-up. */
  recipient: Schema.optionalKey(Schema.Boolean),
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

/** Change the saved hub as it is now (what an earlier step recorded stays). */
export const updateHub = (home: string, change: (hub: HubRequest) => HubRequest) =>
  Effect.gen(function* () {
    const now = yield* readHub(home);
    if (Option.isSome(now)) yield* writeHub(home, change(now.value));
  });

export const dropHub = (home: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(hubPath(home), { force: true })),
    Effect.ignore,
  );

/** Whether `config`'s own machine is an authority. */
export const isAuthority = (config: Config) =>
  config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") ?? false;

/**
 * Setting up a hub changes the fleet for every machine and grants it the
 * secrets: an authority's to do, never a member's (a member proposes).
 */
export const requireAuthority = (config: Config) =>
  isAuthority(config)
    ? Effect.void
    : Effect.fail(
        `${config.self} is not an authority, so it cannot set up the fleet's hub: run the setup of the hub on an authority (t3-fleet ui there), or have an authority give ${config.self} the authority role`,
      );

/** Refuse when `paths` have edits of someone's own: committing them along would publish them unseen. */
const refuseDirty = (repo: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dirty = yield* changedFiles(repo, paths);
    if (dirty.length > 0)
      return yield* Effect.fail(
        `${repo} has uncommitted changes to ${dirty.join(", ")}; commit and push them (or set them aside with git stash) first, then try again`,
      );
  });

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
  for (const command of ["tailscale", process.env["T3_FLEET_TAILSCALE_APP"] ?? TAILSCALE_APP]) {
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
 * Only an authority admits a hub, and never over edits of the user's own to
 * those files. [defaults.mcp] is not part of it: that moves every machine's
 * MCP servers, so it waits until the hub is up (hostMcp).
 */
export const admitHub = (config: Config, hub: HubRequest, owner: string | null = null) =>
  underSyncLock(
    Effect.gen(function* () {
      yield* requireAuthority(config);
      const fs = yield* FileSystem.FileSystem;
      const repo = config.repo;
      const paths = [`nodes/${hub.node}.toml`, FLEET_FILE, ...SECRETS_FILES];
      yield* refuseDirty(repo, paths);
      const lines: Array<string> = [];
      const added: { -readonly [K in keyof Admitted]: Admitted[K] } = {
        node: false,
        relay: false,
        ui: false,
        token: false,
      };
      const nodeFile = `${repo}/nodes/${hub.node}.toml`;
      const nodeExisted = yield* fs.exists(nodeFile);
      const nodeBefore = nodeExisted
        ? yield* fs.readFileString(nodeFile)
        : newNodeFile(hub.node, ["member", "relay"], "t3-fleet setup");
      const nodeAfter = yield* edited(`nodes/${hub.node}.toml`, nodeBefore, [
        (t) => {
          const roles = rolesOf(t);
          return roles.includes("relay")
            ? { text: t }
            : setKey(t, [], "roles", [...roles, "relay"]);
        },
        (t) => (/^ssh\s*=/m.test(t) ? { text: t } : setKey(t, [], "ssh", hub.ssh)),
      ]);
      if (nodeAfter !== nodeBefore || !nodeExisted) {
        yield* fs.writeFileString(nodeFile, nodeAfter);
        added.node = !nodeExisted;
        lines.push(`nodes/${hub.node}.toml: the relay, reached at ${hub.ssh}`);
      }
      const fleetFile = `${repo}/${FLEET_FILE}`;
      const fleetBefore = yield* fs.readFileString(fleetFile);
      let fleetAfter = fleetBefore;
      if (!/^\[relay\]/m.test(fleetAfter)) {
        fleetAfter = yield* edited(FLEET_FILE, fleetAfter, [(t) => relayEdits(t, hub.relayUrl)]);
        added.relay = true;
        lines.push(
          hub.relayUrl === null
            ? `[relay] in ${FLEET_FILE}; set its url once ${hub.node} can be reached`
            : `[relay] in ${FLEET_FILE}: ${hub.relayUrl}`,
        );
      }
      const applied = yield* edited(FLEET_FILE, fleetAfter, [applyRelay]);
      if (applied !== fleetAfter) {
        fleetAfter = applied;
        lines.push(
          `relay in [fleet] apply: sync runs the relay on ${hub.node} and a listener on every other machine`,
        );
      }
      if (hub.mcp === true && hub.relayUrl === null)
        return yield* Effect.fail(
          `${hub.node} has no relay URL for the MCP hub to be reached at: tailscale on ${hub.node}, then try again`,
        );
      const uiBefore = /^\[ui\]/m.test(fleetAfter);
      if (owner !== null && config.settings.ui?.allow === undefined && !uiBefore) {
        fleetAfter = yield* edited(FLEET_FILE, fleetAfter, [
          (t) => setKey(t, ["ui"], "allow", [owner]),
        ]);
        added.ui = true;
        lines.push(`[ui] in ${FLEET_FILE}: the app on ${hub.node} opens for ${owner}`);
      }
      if (hub.hostsApp === false && config.settings.ui?.hosted === undefined) {
        const hosted = yield* edited(FLEET_FILE, fleetAfter, [
          (t) => setKey(t, ["ui"], "hosted", false),
        ]);
        if (hosted !== fleetAfter) {
          fleetAfter = hosted;
          if (uiBefore) added.hosted = true;
          else added.ui = true;
          lines.push(
            `[ui] hosted = false in ${FLEET_FILE}: ${hub.node} cannot serve the fleet app, so t3-fleet ui opens it on each machine`,
          );
        }
      }
      if (fleetAfter !== fleetBefore) yield* fs.writeFileString(fleetFile, fleetAfter);
      const secrets = yield* readSecrets(repo);
      if (!varNames(secrets).includes(RELAY_TOKEN)) {
        yield* writeSecrets(repo, setVar(secrets, RELAY_TOKEN, hex(randomBytes(32))));
        yield* installSecrets(repo);
        added.token = true;
        lines.push(`a new ${RELAY_TOKEN}, encrypted among the secrets`);
      }
      const rev = yield* commitAndPush(repo, paths, `Make ${hub.node} the relay`).pipe(
        // Nothing of this run's stays uncommitted: what was refused is put back.
        Effect.tapError(() =>
          changedFiles(repo, paths).pipe(
            Effect.flatMap((left) => restorePaths(repo, left)),
            Effect.ignore,
          ),
        ),
      );
      if (rev !== "nothing to commit") lines.push(`committed and pushed ${rev}`);
      return {
        lines: lines.length === 0 ? [`${hub.node} is in the fleet already`] : lines,
        added: added as Admitted,
      };
    }),
  );

/** How to let a login into the app on the hub by hand, for when setup cannot tell whose it is. */
export const ALLOW_BY_HAND = `add your Tailscale login to ${FLEET_FILE} on an authority, [ui] allow = ["you@example.com"], then commit and push it (or run \`t3-fleet ui\` here and set the hub up from there)`;

/**
 * [ui] allow with this authority's Tailscale login, when the fleet has a
 * relay and no [ui] yet: the app the hub hosts opens for whoever approved it,
 * as the wizard's admission does. For the terminal's way to a hub (`setup
 * --relay` there, then `t3-fleet approve` here). Lines saying what it did;
 * none when there was nothing to do. Without a login to name, how to add it.
 */
export const allowOwner = Effect.gen(function* () {
  const config = yield* loadConfig.pipe(Effect.mapError((e) => e.message));
  if (config.settings.relay === undefined || config.settings.ui !== undefined) return [];
  if (!isAuthority(config)) return [];
  const hub = config.nodes.find((n) => n.roles.includes("relay"))?.name ?? "the hub";
  const login = yield* tailscaleLogin;
  if (login === null)
    return [
      `The app on ${hub} opens for nobody yet, and this machine has no Tailscale login to name: ${ALLOW_BY_HAND}`,
    ];
  return yield* waitForSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* refuseDirty(config.repo, [FLEET_FILE]);
      yield* pullBranch(config.repo, config.branch, "rebase");
      const fleetFile = `${config.repo}/${FLEET_FILE}`;
      const before = yield* fs.readFileString(fleetFile);
      if (/^\[ui\]/m.test(before)) return [];
      yield* fs.writeFileString(
        fleetFile,
        yield* edited(FLEET_FILE, before, [(t) => setKey(t, ["ui"], "allow", [login])]),
      );
      const rev = yield* commitAndPush(
        config.repo,
        [FLEET_FILE],
        `Let ${login} open the app on ${hub}`,
      ).pipe(Effect.tapError(() => restorePaths(config.repo, [FLEET_FILE]).pipe(Effect.ignore)));
      return [`[ui] allow in ${FLEET_FILE}: the app on ${hub} opens for ${login} (${rev})`];
    }),
  ).pipe(
    Effect.mapError((e) =>
      typeof e === "string"
        ? e
        : typeof e === "object" && e !== null && "message" in e
          ? String(e.message)
          : String(e),
    ),
  );
});

/**
 * [defaults.mcp] hub and gateway: every machine's MCP servers go through the
 * hub from their next sync. Only once the hub is up (its sync succeeded),
 * and only from an authority.
 */
export const hostMcp = (config: Config, hub: HubRequest) =>
  underSyncLock(
    Effect.gen(function* () {
      yield* requireAuthority(config);
      if (hub.relayUrl === null)
        return yield* Effect.fail(
          `${hub.node} has no relay URL for the MCP hub to be reached at: tailscale on ${hub.node}, then try again`,
        );
      const gateway = hub.relayUrl;
      const fs = yield* FileSystem.FileSystem;
      yield* refuseDirty(config.repo, [FLEET_FILE, "mcp"]);
      const fleetFile = `${config.repo}/${FLEET_FILE}`;
      const before = yield* fs.readFileString(fleetFile);
      const after = yield* edited(FLEET_FILE, before, [(t) => mcpHubEdits(t, gateway)]);
      // The servers it can host become its own (`remote`); the rest stay on each machine, said why.
      const moved = yield* moveServersToHub(config.repo).pipe(
        Effect.mapError((e) => `reading the fleet's MCP servers: ${e.message}`),
      );
      const words = movedLines(hub.node, moved);
      if (after === before && moved.files.length === 0)
        return [`your MCP servers run on ${hub.node} already`, ...words];
      if (after !== before) yield* fs.writeFileString(fleetFile, after);
      const paths = [FLEET_FILE, ...moved.files];
      const rev = yield* commitAndPush(
        config.repo,
        paths,
        `Host the fleet's MCP servers on ${hub.node}`,
      ).pipe(Effect.tapError(() => restorePaths(config.repo, paths).pipe(Effect.ignore)));
      return [
        `[defaults.mcp] hub in ${FLEET_FILE}: your MCP servers run on ${hub.node} (${rev})`,
        ...words,
      ];
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

/**
 * Whether the hub's proposal, `commit`, is exactly what joining brings that
 * admission could not write for it: its own proposed secrets, one regular
 * file, added or changed. Anything else (its node file, a role, a profile, a
 * setting, a mode or a link) waits for a person's review like any proposal.
 */
export const onboardingOnly = (repo: string, node: string, commit: string) =>
  Effect.gen(function* () {
    const raw = yield* git(repo, ["diff-tree", "-r", "-z", "--no-renames", `${commit}^`, commit]);
    if (!ok(raw)) return false;
    // ":<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0", once per file.
    const fields = raw.stdout.split("\0").filter((f) => f !== "");
    if (fields.length !== 2) return false;
    const [meta, file] = fields as [string, string];
    const [, newMode, , , status] = meta.replace(/^:/, "").split(" ");
    return (
      file === `${PROPOSED_SECRETS}/${node}.env.age` &&
      newMode === "100644" &&
      (status === "A" || status === "M")
    );
  });

/** Bring the hub up: every step in order, each said through `step`; `home` keeps what it committed. */
export const bringUp = (
  hub: HubRequest,
  step: (text: string) => Effect.Effect<void>,
  home: string = process.env["HOME"] ?? "",
): Effect.Effect<void, string, ProbeServices> =>
  Effect.gen(function* () {
    const message = (e: unknown) =>
      typeof e === "string"
        ? e
        : typeof e === "object" && e !== null && "message" in e
          ? String(e.message)
          : String(e);
    const config = yield* loadConfig.pipe(Effect.mapError(message));
    yield* requireAuthority(config);
    // Read again before each step that changes the fleet: the repo may have changed under it.
    const authorityNow = loadConfig.pipe(Effect.mapError(message), Effect.tap(requireAuthority));
    const titles = hubStepTitles(hub);
    const [admit, join, key, review, sync, check] = titles;
    const publish = hub.mcp === true ? titles[6] : undefined;
    const listen = titles.at(-1);
    // A sync this computer's timer started meanwhile only delays a step that changes the repo.
    const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      waitForSyncLock(effect, {
        waiting: step("Waiting for the sync running on this computer to finish"),
      });
    yield* step(admit ?? "");
    const repoUrl = out(yield* git(config.repo, ["remote", "get-url", "origin"]));
    if (repoUrl === "")
      return yield* Effect.fail("the fleet's repo has no remote, so the hub cannot clone it");
    // A machine in another fleet is refused before this fleet's repo names it anything.
    const membership = yield* hubMembership(hub.ssh);
    const taken = membershipProblem(membership, repoUrl, hub.node);
    if (taken !== null) return yield* Effect.fail(`${hub.node} (${hub.ssh}): ${taken}`);
    const owner = yield* tailscaleLogin;
    const admitted = yield* locked(admitHub(config, hub, owner)).pipe(Effect.mapError(message));
    // A resume admits nothing new: what the first admission added is kept.
    yield* updateHub(home, (h) => ({
      ...h,
      admitted: {
        node: (h.admitted?.node ?? false) || admitted.added.node,
        relay: (h.admitted?.relay ?? false) || admitted.added.relay,
        ui: (h.admitted?.ui ?? false) || admitted.added.ui,
        token: (h.admitted?.token ?? false) || admitted.added.token,
        ...((h.admitted?.hosted ?? false) || admitted.added.hosted === true
          ? { hosted: true }
          : {}),
      },
    })).pipe(Effect.ignore);
    for (const line of admitted.lines) yield* step(`✓ ${line}`);

    yield* step(join ?? "");
    yield* bringUpHub({
      ssh: hub.ssh,
      node: hub.node,
      repoUrl,
      relayUrl: hub.relayUrl,
      onStep: step,
    });

    yield* step(key ?? "");
    const recipient = yield* hubRecipient(hub.ssh);
    yield* authorityNow;
    const added = yield* locked(
      refuseDirty(config.repo, SECRETS_FILES).pipe(
        Effect.andThen(addRecipient(config.repo, hub.node, recipient)),
        Effect.flatMap((changed) =>
          changed
            ? commitAndPush(config.repo, SECRETS_FILES, `Let ${hub.node} read the fleet's secrets`)
            : Effect.succeed("nothing to commit"),
        ),
      ),
    ).pipe(Effect.mapError(message));
    if (added !== "nothing to commit")
      yield* updateHub(home, (h) => ({ ...h, recipient: true })).pipe(Effect.ignore);
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
    else if (!(yield* onboardingOnly(config.repo, hub.node, proposal.commit)))
      yield* step(
        `${hub.node} proposed more than its own secrets (${proposal.files.join(", ")}); review it under Proposals`,
      );
    else {
      yield* authorityNow;
      // Bound to the commit just checked: a proposal changed since is refused, not approved.
      const approved = yield* locked(
        approve(config.repo, config.branch, proposal, config.self, proposal.commit),
      ).pipe(Effect.mapError(message));
      yield* step(`✓ approved ${hub.node}'s proposed secrets`);
      for (const note of approved.notes) yield* step(`✓ ${note}`);
    }

    yield* step(sync ?? "");
    // --wait: a sync the hub's own timer is running is waited for, never taken for this one.
    const synced = yield* ssh(hub.ssh, "t3-fleet sync --wait", 900);
    const why = lastLine(synced);
    if (synced.code !== 0 && hub.mcp === true)
      // Every machine's MCP servers would move to a hub that is not serving them.
      return yield* Effect.fail(
        `${hub.node}'s sync did not finish (${why}); your MCP servers stay where they are until it does. Fix that, then resume`,
      );
    yield* step(
      synced.code === 0
        ? `✓ ${hub.node} synced`
        : `${hub.node}'s sync did not finish (${why}); its timer tries again`,
    );

    // Done only once the relay answers: on the hub itself, then (said, not required) where machines reach it.
    yield* step(check ?? "");
    const health = yield* ssh(hub.ssh, "t3-fleet relay health --wait 60", 120);
    if (health.code !== 0)
      return yield* Effect.fail(
        `the relay on ${hub.node} does not answer (${lastLine(health)})${synced.code === 0 ? "" : `; its sync said: ${why}`}. t3-fleet status on ${hub.node} says what is wrong; fix that, then resume`,
      );
    yield* step(`✓ the relay answers on ${hub.node}`);
    if (hub.relayUrl !== null) {
      const published = yield* reaches(hub.relayUrl);
      yield* step(
        published === null
          ? `✓ ${hub.relayUrl} answers from this computer`
          : `${hub.relayUrl} does not answer from this computer yet (${published}): the relay runs on ${hub.node}, so check that this computer is on the tailnet and that ${hub.node} publishes its port (t3-fleet status there)`,
      );
    }

    if (hub.mcp === true) {
      yield* step(publish ?? "");
      for (const line of yield* authorityNow.pipe(
        Effect.flatMap((now) => locked(hostMcp(now, hub))),
        Effect.mapError(message),
      ))
        yield* step(`✓ ${line}`);
    }

    // This computer's listener, now, rather than on its next timer run.
    yield* step(listen ?? "");
    for (const line of yield* listenHere.pipe(Effect.mapError(message))) yield* step(line);
  });

const lastLine = (r: ExecResult) =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").pop() || `exit ${r.code}`;

/** Null when `${url}/health` answers 200 from here within half a minute; otherwise why not. */
export const reaches = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const ask = client.execute(HttpClientRequest.get(`${url.replace(/\/+$/, "")}/health`)).pipe(
      Effect.map((r) => (r.status === 200 ? null : `HTTP ${r.status}`)),
      Effect.timeout(Duration.seconds(5)),
      Effect.catch((e) =>
        Effect.succeed(
          typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e),
        ),
      ),
    );
    return yield* ask.pipe(
      Effect.repeat({
        until: (why) => why === null,
        schedule: Schedule.spaced(Duration.seconds(3)),
        times: 10,
      }),
    );
  });

/**
 * A sync of this computer's relay (its listener) and MCP areas, waiting for
 * one already running: what its timer would do next, done now. Lines for
 * what it did, and for a listener it could not start.
 */
const listenHere = Effect.gen(function* () {
  const config = yield* loadConfig;
  const result = yield* syncRun(config, { apply: true, areas: ["relay", "mcp"] }).pipe(
    Effect.repeat({
      while: (r) => r.state === null,
      schedule: Schedule.spaced(Duration.seconds(5)),
      times: 120,
    }),
  );
  if (result.state === null)
    return ["this computer's sync was busy for ten minutes; its timer starts the listener"];
  const left = result.state.findings.filter(
    (f) => f.node === config.self && f.area === "relay" && f.severity !== "info",
  );
  return [
    ...result.lines.map((l) => `✓ ${l}`),
    ...(left.length === 0
      ? [`✓ ${config.self} listens to the relay`]
      : left.map((f) => `${config.self}: ${f.title}`)),
  ];
});

/**
 * Take out what an abandoned bring-up added to the fleet, each part as a new
 * commit: the node (its file, its key among the recipients, its branches) when
 * admission created it, [relay] and [ui] and the relay token when admission
 * added them. What it does, a line each; what stays, said too.
 */
export const undoAdmission = (hub: HubRequest, home: string = process.env["HOME"] ?? "") =>
  Effect.gen(function* () {
    const message = (e: unknown) =>
      typeof e === "string"
        ? e
        : typeof e === "object" && e !== null && "message" in e
          ? String(e.message)
          : String(e);
    const lines: Array<string> = [];
    const added = hub.admitted;
    if (added === undefined && hub.recipient !== true)
      return [`nothing of ${hub.node} was added to the fleet`];
    const config = yield* loadConfig.pipe(Effect.mapError(message));
    yield* requireAuthority(config);
    const repo = config.repo;
    if (added?.node === true) {
      const removed = yield* waitForSyncLock(
        removeNode(
          repo,
          config.branch,
          hub.node,
          home,
          `Take ${hub.node} out of the fleet: its setup as the hub was abandoned`,
        ),
      ).pipe(Effect.mapError(message));
      lines.push(
        removed.rev === null
          ? `${hub.node} was out of the fleet already`
          : `took ${hub.node} out of the fleet (${removed.rev}): its node file and its key`,
      );
    } else if (hub.recipient === true)
      lines.push(
        `${hub.node} was in the fleet before, so it stays, and so does its key among the secrets' recipients`,
      );
    if (added !== undefined && (added.relay || added.ui || added.token || added.hosted === true)) {
      const fs = yield* FileSystem.FileSystem;
      const rev = yield* waitForSyncLock(
        Effect.gen(function* () {
          yield* refuseDirty(repo, [FLEET_FILE, ...SECRETS_FILES]);
          yield* pullBranch(repo, config.branch, "rebase");
          const fleetFile = `${repo}/${FLEET_FILE}`;
          const before = yield* fs.readFileString(fleetFile);
          const after = yield* edited(FLEET_FILE, before, [
            (t) => (added.relay ? dropTable(t, ["relay"]) : { text: t }),
            (t) => (added.ui ? dropTable(t, ["ui"]) : { text: t }),
            (t) => (added.hosted === true ? dropKey(t, ["ui"], "hosted") : { text: t }),
          ]);
          if (after !== before) yield* fs.writeFileString(fleetFile, after);
          if (added.token) {
            const secrets = yield* readSecrets(repo);
            if (varNames(secrets).includes(RELAY_TOKEN)) {
              yield* writeSecrets(repo, setVar(secrets, RELAY_TOKEN, null));
              yield* installSecrets(repo);
            }
          }
          return yield* commitAndPush(
            repo,
            [FLEET_FILE, ...SECRETS_FILES],
            `Undo making ${hub.node} the relay: its setup as the hub was abandoned`,
          );
        }),
      ).pipe(Effect.mapError(message));
      lines.push(
        `took out ${[
          ...(added.relay ? ["[relay]"] : []),
          ...(added.ui ? ["[ui]"] : []),
          ...(added.hosted === true && !added.ui ? ["[ui] hosted"] : []),
          ...(added.token ? [RELAY_TOKEN] : []),
        ].join(", ")}${rev === "nothing to commit" ? " (gone already)" : ` (${rev})`}`,
      );
    }
    lines.push(
      `T3 Fleet stays installed on ${hub.node}, if it got that far: \`t3-fleet leave\` there removes it`,
    );
    return lines;
  });
