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
  appliesRelay,
  mcpHubEdits,
  movedLines,
  moveServersToHub,
  relayEdits,
  relayUrlIn,
  rolesOf,
} from "./Apply.ts";
import { PROPOSED_SECRETS } from "./Plan.ts";
import { hubStepTitles } from "./PlanWords.ts";
import { bringUpHub, hubMembership, membershipProblem } from "./Remote.ts";
import { newNodeFile } from "./Repo.ts";
import { dropKey, dropTable, removeFromList, setKey, type Edit } from "./TomlEdit.ts";

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
  /** The relay role, added to a node file that was there before. */
  relayRole: Schema.optionalKey(Schema.Boolean),
  /** `ssh`, added to a node file that was there before. */
  ssh: Schema.optionalKey(Schema.Boolean),
  /** `relay`, added to a `[fleet] apply` list that was there before without it. */
  applyRelay: Schema.optionalKey(Schema.Boolean),
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

/**
 * The saved hub; none when there is no hub.json. One that is there but
 * unreadable fails, naming the file: taking it for none would lose a
 * half-admitted hub, with nothing left to resume or abandon.
 */
export const readHub = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(hubPath(home)).pipe(Effect.orElseSucceed(() => false))))
      return Option.none<HubRequest>();
    const text = yield* fs.readFileString(hubPath(home)).pipe(Effect.option);
    const hub = Option.flatMap(text, Schema.decodeOption(Schema.fromJsonString(HubRequest)));
    if (Option.isNone(hub))
      return yield* Effect.fail(
        `${hubPath(home)} is unreadable, so the hub's setup cannot be resumed or abandoned from it; look at it, then move it aside to start the hub over`,
      );
    return hub;
  });

/** Written to a file of its own and renamed over hub.json: a reader never sees half of it. */
export const writeHub = (home: string, hub: HubRequest) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${stateDir(home)}/setup`, { recursive: true });
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(HubRequest))(hub);
    const temp = `${hubPath(home)}.${process.pid}.tmp`;
    yield* fs.writeFileString(temp, `${text}\n`, { mode: 0o600 });
    yield* fs.rename(temp, hubPath(home));
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
 * Why `hub` cannot be made the fleet's hub when the fleet has a relay already:
 * another machine holds the relay role, or [relay] url (`url`) names another
 * address. Null when it has none, or the relay is `hub` itself (a resume).
 * Moving the relay is a person's decision, made by hand, never a side effect
 * of setup.
 */
export const otherRelay = (config: Config, url: string | null, hub: HubRequest): string | null => {
  const holder = config.nodes.find((n) => n.name !== hub.node && n.roles.includes("relay"));
  const how = `To move the hub, take the relay role off the old one (its nodes/<name>.toml) and [relay] out of ${FLEET_FILE} on an authority, commit and push, then set ${hub.node} up again`;
  if (holder !== undefined)
    return `${holder.name} is the fleet's hub (its relay) already, so ${hub.node} cannot be one as well: every machine reaches the one relay [relay] url names. ${how}`;
  if (url !== null && url !== hub.relayUrl)
    return `the fleet's relay is at ${url} already${hub.relayUrl === null ? "" : `, not at ${hub.relayUrl} where ${hub.node} answers`}, so ${hub.node} cannot be made the hub over it. ${how}`;
  return null;
};

/** The commit admitting `node` as the hub. */
const admissionMessage = (node: string) => `Make ${node} the relay`;

/**
 * Take back an admission commit that never reached origin: a push that failed
 * after the commit, or a run that stopped between the two, leaves one, and a
 * later admission would find nothing to commit and push nothing. Only HEAD,
 * only when it is that commit, touching only `paths`, and not on its
 * upstream; HEAD goes back one and `paths` back to it, so admission is done
 * again in full and pushed. True when it took one back.
 */
const takeBackUnpushedAdmission = (repo: string, node: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (out(yield* git(repo, ["log", "-1", "--format=%s"])) !== admissionMessage(node))
      return false;
    if (!ok(yield* git(repo, ["rev-parse", "-q", "--verify", "@{upstream}"]))) return false;
    if (ok(yield* git(repo, ["merge-base", "--is-ancestor", "HEAD", "@{upstream}"]))) return false;
    if (!ok(yield* git(repo, ["rev-parse", "-q", "--verify", "HEAD~1"]))) return false;
    const touched = out(
      yield* git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
    ).split("\n");
    if (touched.some((f) => f !== "" && !paths.includes(f))) return false;
    if (!ok(yield* git(repo, ["reset", "-q", "--soft", "HEAD~1"]))) return false;
    yield* restorePaths(repo, paths);
    return true;
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
      if (hub.mcp === true && hub.relayUrl === null)
        return yield* Effect.fail(
          `${hub.node} has no relay URL for the MCP hub to be reached at: tailscale on ${hub.node}, then try again`,
        );
      const fs = yield* FileSystem.FileSystem;
      const repo = config.repo;
      const paths = [`nodes/${hub.node}.toml`, FLEET_FILE, ...SECRETS_FILES];
      // Left by a run that stopped after committing and before pushing: done again below.
      yield* takeBackUnpushedAdmission(repo, hub.node, paths);
      yield* refuseDirty(repo, paths);
      // One relay: machines reach the one [relay] url names, so a second hub would split them.
      const fleetFile = `${repo}/${FLEET_FILE}`;
      const fleetBefore = yield* fs.readFileString(fleetFile);
      const taken = otherRelay(config, relayUrlIn(fleetBefore), hub);
      if (taken !== null) return yield* Effect.fail(taken);
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
      const withRole = yield* edited(`nodes/${hub.node}.toml`, nodeBefore, [
        (t) => {
          const roles = rolesOf(t);
          return roles.includes("relay")
            ? { text: t }
            : setKey(t, [], "roles", [...roles, "relay"]);
        },
      ]);
      const nodeAfter = yield* edited(`nodes/${hub.node}.toml`, withRole, [
        (t) => (/^ssh\s*=/m.test(t) ? { text: t } : setKey(t, [], "ssh", hub.ssh)),
      ]);
      if (nodeAfter !== nodeBefore || !nodeExisted) {
        yield* fs.writeFileString(nodeFile, nodeAfter);
        added.node = !nodeExisted;
        // Into a node file that was there: each edit, so an abandon takes out only those.
        if (nodeExisted && withRole !== nodeBefore) added.relayRole = true;
        if (nodeExisted && nodeAfter !== withRole) added.ssh = true;
        lines.push(`nodes/${hub.node}.toml: the relay, reached at ${hub.ssh}`);
      }
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
      // relay put into a [fleet] apply that left it out, here or by relayEdits: the fleet's own
      // policy, so an abandon puts it back as it was.
      if (appliesRelay(fleetBefore) === false && appliesRelay(fleetAfter) === true)
        added.applyRelay = true;
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
      const rev = yield* commitAndPush(repo, paths, admissionMessage(hub.node)).pipe(
        // Nothing of this run's stays, committed or not: a commit the push did not take is
        // taken back, so trying again admits the hub afresh; what was refused is put back.
        Effect.catch((e) =>
          Effect.gen(function* () {
            const takenBack = yield* takeBackUnpushedAdmission(repo, hub.node, paths).pipe(
              Effect.orElseSucceed(() => false),
            );
            yield* changedFiles(repo, paths).pipe(
              Effect.flatMap((left) => restorePaths(repo, left)),
              Effect.ignore,
            );
            return yield* Effect.fail(
              takenBack
                ? `${e}; the commit was taken back, so trying again admits ${hub.node} afresh`
                : e,
            );
          }),
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

/** The text of `file` at `rev` in the repo; null when it has none there. */
const fileAt = (repo: string, rev: string, file: string) =>
  git(repo, ["show", `${rev}:${file}`]).pipe(Effect.map((r) => (ok(r) ? r.stdout : null)));

/**
 * What approving `proposal` would also do, decided before it is approved so
 * it is shown with the proposal: when it makes its machine the fleet's relay
 * (`setup --relay` there) and the fleet lets no one into the app the hub
 * hosts yet, approving on this authority also lets this machine's Tailscale
 * login in ([ui] allow), as the wizard's admission does. Null for any other
 * proposal: approving one never changes who may open the app. `login` is
 * null when this machine has none to name.
 */
export const ownerAccess = (
  config: Config,
  proposal: { readonly node: string; readonly commit: string },
) =>
  Effect.gen(function* () {
    if (!isAuthority(config) || config.settings.ui !== undefined) return null;
    const nodeFile = `nodes/${proposal.node}.toml`;
    const proposed = yield* fileAt(config.repo, proposal.commit, nodeFile);
    if (proposed === null || !rolesOf(proposed).includes("relay")) return null;
    const branch = `origin/${config.branch}`;
    const now = yield* fileAt(config.repo, branch, nodeFile);
    if (now !== null && rolesOf(now).includes("relay")) return null;
    for (const rev of [branch, proposal.commit]) {
      const fleet = yield* fileAt(config.repo, rev, FLEET_FILE);
      if (fleet !== null && /^\[ui\]/m.test(fleet)) return null;
    }
    return { hub: proposal.node, login: yield* tailscaleLogin };
  });

export type OwnerAccess = { readonly hub: string; readonly login: string | null };

/** What `ownerAccess` says approving also does, in the words review and approve show. */
export const ownerAccessLine = (access: OwnerAccess) =>
  access.login === null
    ? `The app on ${access.hub} will open for nobody, and this machine has no Tailscale login to name: ${ALLOW_BY_HAND}`
    : `Approving also lets ${access.login} open the app on ${access.hub}: [ui] allow = ["${access.login}"] in ${FLEET_FILE}, committed and pushed on its own`;

/**
 * [ui] allow with `login`, when the fleet has a relay and no [ui] yet: the
 * app the hub hosts opens for whoever set it up. Lines saying what it did;
 * none when there was nothing to do. Without a login to name, how to add it.
 */
export const allowLogin = (access: OwnerAccess) =>
  Effect.gen(function* () {
    const config = yield* loadConfig.pipe(Effect.mapError((e) => e.message));
    if (config.settings.relay === undefined || config.settings.ui !== undefined) return [];
    if (!isAuthority(config)) return [];
    const { hub, login } = access;
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
 * [ui] allow with this authority's Tailscale login, at the end of the setup of
 * an authority that is its own relay: the app it hosts opens for it, as the
 * wizard's admission does.
 */
export const allowOwner = Effect.gen(function* () {
  const config = yield* loadConfig.pipe(Effect.mapError((e) => e.message));
  if (config.settings.relay === undefined || config.settings.ui !== undefined) return [];
  if (!isAuthority(config)) return [];
  const hub = config.nodes.find((n) => n.roles.includes("relay"))?.name ?? "the hub";
  return yield* allowLogin({ hub, login: yield* tailscaleLogin });
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
        ...((h.admitted?.relayRole ?? false) || admitted.added.relayRole === true
          ? { relayRole: true }
          : {}),
        ...((h.admitted?.ssh ?? false) || admitted.added.ssh === true ? { ssh: true } : {}),
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
      // The hub takes it now, not on its next timer run; its relay sees the change and restarts with it.
      const taken = yield* ssh(hub.ssh, "t3-fleet sync --wait", 900);
      yield* step(
        taken.code === 0
          ? `✓ ${hub.node} has it; its relay restarts within a minute to host them`
          : `${hub.node} takes it on its next sync (${lastLine(taken)}); its relay restarts then`,
      );
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
    // Edits to a node file that was there before (its file stays, with what it had).
    const nodeEdits =
      added !== undefined && !added.node && (added.relayRole === true || added.ssh === true);
    if (
      added !== undefined &&
      (added.relay ||
        added.ui ||
        added.token ||
        added.hosted === true ||
        added.applyRelay === true ||
        nodeEdits)
    ) {
      const fs = yield* FileSystem.FileSystem;
      const nodePath = `nodes/${hub.node}.toml`;
      const paths = [FLEET_FILE, ...SECRETS_FILES, ...(nodeEdits ? [nodePath] : [])];
      const rev = yield* waitForSyncLock(
        Effect.gen(function* () {
          yield* refuseDirty(repo, paths);
          yield* pullBranch(repo, config.branch, "rebase");
          if (nodeEdits) {
            const nodeFile = `${repo}/${nodePath}`;
            const text = yield* fs.readFileString(nodeFile).pipe(Effect.orElseSucceed(() => null));
            if (text !== null) {
              const restored = yield* edited(nodePath, text, [
                (t) =>
                  added.relayRole === true
                    ? removeFromList(t, [], "roles", ["relay"])
                    : { text: t },
                (t) => (added.ssh === true ? dropKey(t, [], "ssh") : { text: t }),
              ]);
              if (restored !== text) yield* fs.writeFileString(nodeFile, restored);
            }
          }
          const fleetFile = `${repo}/${FLEET_FILE}`;
          const before = yield* fs.readFileString(fleetFile);
          const after = yield* edited(FLEET_FILE, before, [
            (t) => (added.relay ? dropTable(t, ["relay"]) : { text: t }),
            (t) => (added.ui ? dropTable(t, ["ui"]) : { text: t }),
            (t) => (added.hosted === true ? dropKey(t, ["ui"], "hosted") : { text: t }),
            (t) =>
              added.applyRelay === true
                ? removeFromList(t, ["fleet"], "apply", ["relay"])
                : { text: t },
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
            paths,
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
          ...(added.applyRelay === true ? ["relay from [fleet] apply"] : []),
          ...(nodeEdits && added.relayRole === true ? [`${hub.node}'s relay role`] : []),
          ...(nodeEdits && added.ssh === true ? [`${hub.node}'s ssh`] : []),
        ].join(", ")}${rev === "nothing to commit" ? " (gone already)" : ` (${rev})`}`,
      );
    }
    lines.push(
      `T3 Fleet stays installed on ${hub.node}, if it got that far: \`t3-fleet leave\` there removes it`,
    );
    return lines;
  });
