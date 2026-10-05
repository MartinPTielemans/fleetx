/**
 * `t3-fleet leave`: take this machine out of the fleet and leave it working on
 * its own. Planning only reads (it fetches the config repo's origin); each
 * step says what it will do, without any secret's value, and runs only once
 * the person has seen the plan. The pieces are in leave/:
 *
 *   fleet       an authority removes itself on origin (Fleet.ts), refused when
 *               no other authority would be left; a member proposes its
 *               departure for an authority to approve
 *   services    the sync timer, `listen`, `relay serve` and the model proxy,
 *               stopped, verified stopped, and their units removed
 *   links       every link into the config repo becomes a real copy
 *   backups     what setup moved aside goes back, over T3 Fleet's link only
 *   models      T3's providers point where they did before, then the
 *               launchers no provider uses any more are removed
 *   mcp         Claude's and Codex's servers from before setup come back,
 *               over entries that are still T3 Fleet's
 *   purge       with --purge: ~/.config/t3-fleet, ~/.local/state/t3-fleet and
 *               the installed bundle; backups of the user's own files stay
 *
 * Leaving can be interrupted and run again. Before the first step it records
 * the departure (the node, its repo and settings) in
 * ~/.local/state/t3-fleet/leave.json, so a run whose node file is already
 * gone, or a later `leave --purge`, still knows what to undo. The whole run
 * holds the sync lock, so no sync runs halfway through it.
 *
 * The config repo checkout is never deleted.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { identityToRecipient } from "age-encryption";
import { parse as parseToml } from "smol-toml";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { shPath } from "./Area.ts";
import { expandHome, loadConfig, localConfigPath, type Config } from "./Config.ts";
import { git, ok, out } from "./Git.ts";
import { leaveFleet, standing, type Standing } from "./leave/Fleet.ts";
import { linkTarget, present, replaceWith, tilde, within, writeAtomically } from "./leave/Files.ts";
import {
  convert,
  expectedTargets,
  finishUnfinished,
  installedTargets,
  planLinks,
  repoRoots,
} from "./leave/Links.ts";
import { applyMcp, planMcp } from "./leave/Mcp.ts";
import { applyModels, planModels } from "./leave/Models.ts";
import { findServices, stopService } from "./leave/Services.ts";
import { branchPrefix, CLI, configDir, SHARE_DIR, stateDir } from "./Names.ts";
import { keyPath, localSecretsPath, varNames } from "./Secrets.ts";
import { underSyncLock } from "./SyncLock.ts";

/** What setup recorded before it changed anything (written by `t3-fleet setup`). */
export const SetupSnapshot = Schema.Struct({
  takenAt: Schema.Number,
  claude: Schema.optionalKey(
    Schema.Struct({
      mcpServers: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  ),
  codex: Schema.optionalKey(
    Schema.Struct({
      mcp_servers: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  ),
  moved: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, backup: Schema.String })),
  ),
});
export type SetupSnapshot = typeof SetupSnapshot.Type;

/** ~/.local/state/t3-fleet/setup/before.json */
export const setupSnapshotPath = (home: string) => `${stateDir(home)}/setup/before.json`;

// ---- the departure, recorded ------------------------------------------------

/**
 * Which enrollment a departure is of: the config repo's origin and this
 * machine's key. A record of another enrollment (the machine left one fleet
 * halfway and joined another) is never resumed.
 */
export const Enrollment = Schema.Struct({
  remote: Schema.NullOr(Schema.String),
  /** This machine's public age key. */
  key: Schema.NullOr(Schema.String),
  /**
   * The config repo checkout, by its real path and the id kept in its .git
   * (ENROLLMENT_ID): a machine that joins again under the same name, even
   * with the same key and remote, has another checkout, or a fresh clone in
   * the same place with another id. Absent from records of older versions.
   */
  checkout: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type Enrollment = typeof Enrollment.Type;

/** What leaving needs to know about this machine, kept for as long as leaving takes. */
export const Departure = Schema.Struct({
  node: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  roles: Schema.Array(Schema.String),
  /** The node's merged settings, as they were. */
  settings: Schema.Record(Schema.String, Schema.Unknown),
  /** Every step has run; a later `leave` only purges. */
  finished: Schema.Boolean,
  /** Recorded with the departure, when it first runs. */
  enrollment: Schema.optionalKey(Enrollment),
});
export type Departure = typeof Departure.Type;

/** ~/.local/state/t3-fleet/leave.json */
export const departurePath = (home: string) => `${stateDir(home)}/leave.json`;

const decodeDeparture = Schema.decodeUnknownOption(Schema.fromJsonString(Departure));
const encodeDeparture = Schema.encodeSync(Schema.fromJsonString(Departure));
const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(SetupSnapshot));

export const departureOf = (config: Config): Departure => {
  const node = config.nodes.find((n) => n.name === config.self);
  return {
    node: config.self,
    repo: config.repo,
    branch: config.branch,
    roles: node?.roles ?? [],
    settings: (node?.settings.table ?? {}) as Record<string, unknown>,
    finished: false,
  };
};

/** The enrollment of the repo at `repo` and this machine's key, as they are now. */
/** The file in a checkout's .git holding its enrollment id, made the first time it is asked for. */
export const ENROLLMENT_ID = "t3-fleet-enrollment";

/**
 * The enrollment of the checkout at `repo` and this machine's key, as they
 * are now. With `create`, a checkout without an id gets one; otherwise its
 * id is null.
 */
export const enrollmentOf = (home: string, repo: string, create = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const remote = yield* git(repo, ["remote", "get-url", "origin"]);
    const identity = (yield* fs.readFileString(keyPath(home)).pipe(Effect.orElseSucceed(() => "")))
      .split("\n")
      .find((l) => l.startsWith("AGE-SECRET-KEY-"));
    const key =
      identity === undefined
        ? null
        : yield* Effect.tryPromise(() => identityToRecipient(identity)).pipe(
            Effect.orElseSucceed(() => null),
          );
    const checkout = Option.getOrNull(yield* fs.realPath(repo).pipe(Effect.option));
    const gitDir = yield* git(repo, ["rev-parse", "--absolute-git-dir"]);
    let id: string | null = null;
    if (ok(gitDir)) {
      const file = `${out(gitDir)}/${ENROLLMENT_ID}`;
      id = Option.getOrNull(
        yield* fs.readFileString(file).pipe(
          Effect.map((t) => t.trim()),
          Effect.option,
        ),
      );
      if (id === null && create) {
        const parts: Array<string> = [];
        for (let i = 0; i < 4; i++)
          parts.push((yield* Random.nextIntBetween(0, 2 ** 31)).toString(16).padStart(8, "0"));
        id = parts.join("");
        yield* fs.writeFileString(file, `${id}\n`).pipe(Effect.orElseSucceed(() => (id = null)));
      }
    }
    return {
      remote: ok(remote) ? out(remote) : null,
      key,
      checkout,
      id: id === "" ? null : id,
    } satisfies Enrollment;
  });

/** Who this machine is now: the node its local config names, and that checkout's enrollment. */
export const currentIdentity = (home: string, fallbackRepo: string, create = false) =>
  Effect.gen(function* () {
    const local = yield* localEnrollment(home);
    return {
      node: local?.node ?? null,
      enrollment: yield* enrollmentOf(home, local?.repo ?? fallbackRepo, create),
    };
  });
export type Identity = { readonly node: string | null; readonly enrollment: Enrollment };

/**
 * What differs between the enrollment leave planned for and the one now,
 * field by field and strictly: a key, origin, checkout or id that was there
 * when it planned and is gone, unreadable or another now, and one that has
 * appeared since. (A recorded departure is compared more leniently, below:
 * a purge that stopped halfway has rightly removed the key.)
 */
const identityChanges = (planned: Enrollment, now: Enrollment) => {
  const differs: Array<string> = [];
  const field = (name: string, was: string | null | undefined, is: string | null | undefined) => {
    if ((was ?? null) === (is ?? null)) return;
    differs.push(
      was === null || was === undefined
        ? `it has ${name} now that it did not have`
        : is === null || is === undefined
          ? `its ${name} is gone or cannot be read`
          : `its ${name} is another one`,
    );
  };
  field("key", planned.key, now.key);
  field("config repo origin", planned.remote, now.remote);
  field("checkout", planned.checkout, now.checkout);
  field("checkout id", planned.id, now.id);
  return differs;
};

/** What differs between an enrollment recorded and one now, said for a person; empty when nothing does. */
const enrollmentChanges = (was: Enrollment, now: Enrollment) => {
  const differs: Array<string> = [];
  const known = <A>(a: A | null | undefined, b: A | null | undefined) =>
    a !== null && a !== undefined && b !== null && b !== undefined;
  if (known(was.remote, now.remote) && was.remote !== now.remote)
    differs.push(`its config repo is ${now.remote} now, not ${was.remote}`);
  if (known(was.key, now.key) && was.key !== now.key) differs.push("its key is a new one");
  if (was.checkout !== undefined && was.checkout !== null && was.checkout !== now.checkout)
    differs.push(`its checkout is ${now.checkout ?? "gone"}, not ${was.checkout}`);
  else if (was.id !== undefined && was.id !== null && was.id !== now.id)
    differs.push("its checkout is a new clone");
  return differs;
};

/** Which repo and node this machine's local config names, whether or not the repo still has the node. */
const localEnrollment = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(localConfigPath(home)).pipe(Effect.option);
    const raw = Option.isSome(text)
      ? yield* Effect.try(() => parseToml(text.value) as Record<string, unknown>).pipe(
          Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
        )
      : {};
    const repo = process.env["T3_FLEET_CONFIG_REPO"] ?? raw["repo"];
    const node = process.env["T3_FLEET_NODE"] ?? raw["node"];
    return typeof repo === "string" && typeof node === "string"
      ? { repo: expandHome(repo, home), node }
      : null;
  });

/** A departure recorded here and not finished: what `setup` will not start over. */
export const unfinishedDeparture = (home: string) =>
  readDeparture(home).pipe(Effect.map(Option.filter((d) => !d.finished)));

/**
 * Sets the record of a departure aside (leave-retired-<time>.json beside
 * it), for a departure that is over or given up: nothing else changes, and
 * the next leave or setup starts from this machine as it is. Returns where
 * it goes, or null when there is none; with `dryRun`, only where it would go.
 */
export const retireDeparture = (home: string, options: { readonly dryRun?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = departurePath(home);
    if (!(yield* present(file))) return null;
    const to = `${stateDir(home)}/leave-retired-${yield* Clock.currentTimeMillis}.json`;
    if (options.dryRun !== true)
      yield* fs
        .rename(file, to)
        .pipe(Effect.mapError((e) => `setting ${file} aside: ${e.message}`));
    return to;
  });

const readDeparture = (home: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(departurePath(home))),
    Effect.option,
    Effect.map((text) => (Option.isSome(text) ? decodeDeparture(text.value) : Option.none())),
  );

const writeDeparture = (home: string, departure: Departure) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = departurePath(home);
    const before = Option.getOrNull(yield* fs.readFileString(file).pipe(Effect.option));
    yield* writeAtomically(file, `${encodeDeparture(departure)}\n`, before, { mode: 0o600 });
  });

/**
 * Why a recorded departure is not this machine's current enrollment, or
 * null when it is (or nothing says otherwise: the local config is gone).
 */
const otherEnrollment = (home: string, recorded: Departure) =>
  Effect.gen(function* () {
    const now = yield* currentIdentity(home, recorded.repo);
    const differs: Array<string> = [];
    if (now.node !== null && now.node !== recorded.node)
      differs.push(`it is ${now.node} now, not ${recorded.node}`);
    if (recorded.enrollment !== undefined)
      differs.push(...enrollmentChanges(recorded.enrollment, now.enrollment));
    return differs.length === 0 ? null : differs.join("; ");
  });

/**
 * The departure to plan: an unfinished one recorded here goes on, when it is
 * of this machine's current enrollment; otherwise this machine as its config
 * says; otherwise (its node file is gone) a finished one recorded here, for
 * `--purge`.
 */
export const currentDeparture = (home: string) =>
  Effect.gen(function* () {
    const recorded = yield* readDeparture(home);
    if (Option.isSome(recorded)) {
      const other = yield* otherEnrollment(home, recorded.value);
      if (other !== null)
        return yield* Effect.fail(
          `${tilde(departurePath(home), home)} records ${recorded.value.finished ? "" : "an unfinished "}departure of ${recorded.value.node} from another enrollment (${other}), so it is not resumed. If that departure is over, set it aside with \`t3-fleet leave --retire\` and run leave again.`,
        );
      if (!recorded.value.finished) return { departure: recorded.value, resumed: true };
    }
    const config = yield* loadConfig.pipe(Effect.result);
    if (
      config._tag === "Success" &&
      config.success.nodes.some((n) => n.name === config.success.self)
    )
      return { departure: departureOf(config.success), resumed: false };
    if (Option.isSome(recorded)) return { departure: recorded.value, resumed: true };
    if (config._tag === "Failure") return yield* Effect.fail(config.failure.message);
    return yield* Effect.fail(`${config.success.self} is not in the config repo`);
  });

// ---- the plan ----------------------------------------------------------------

export interface LeaveStep {
  readonly title: string;
  /** What it does: commands, paths, entries; never a secret's value. */
  readonly lines: ReadonlyArray<string>;
  /** Runs the step; its result is a line or two on what it did. */
  readonly apply: Effect.Effect<
    ReadonlyArray<string>,
    string,
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
  >;
}

export interface LeavePlan {
  readonly departure: Departure;
  /** Who this machine was when it planned; checked again before anything runs. */
  readonly identity: Identity;
  readonly home: string;
  readonly purge: boolean;
  /** Why this machine cannot leave yet; when set, nothing runs. */
  readonly refusal: string | null;
  readonly steps: ReadonlyArray<LeaveStep>;
  /** What stays, and what the person still has to do. */
  readonly notes: ReadonlyArray<string>;
}

export interface LeaveOptions {
  readonly home: string;
  readonly purge: boolean;
  /** For tests; this machine's otherwise. */
  readonly platform?: string;
  readonly root?: boolean;
  readonly systemDir?: string;
  readonly stopWait?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Where the departure stands in the fleet, and the step that takes it
 * further. The role is origin's, not the one recorded: a machine promoted or
 * demoted since leaves as what it is now, and the step decides again when it
 * runs (leaveFleet).
 */
const fleetStep = (d: Departure, home: string, at: Standing) => {
  const notes: Array<string> = [];
  if (at._tag === "out") {
    notes.push(`${d.node} is out of the fleet's config repo`);
    return { step: null, refusal: null, notes };
  }
  const authority = at._tag === "in" ? at.authority : d.roles.includes("authority");
  if (at._tag === "in" && authority && at.authorities.length === 0)
    return {
      step: null,
      refusal: `${d.node} is the fleet's only authority; give another machine the authority role (roles = ["authority"] in its nodes/<name>.toml) first, or the fleet would have no one to approve changes`,
      notes,
    };
  if (at._tag === "in" && !authority && at.proposed !== null) {
    notes.push(
      `the departure proposal ${at.proposed} waits for an authority: t3-fleet approve ${d.node} ${at.proposed}`,
    );
    return { step: null, refusal: null, notes };
  }
  if (at._tag === "unknown")
    notes.push(
      `the config repo's origin cannot be reached now (${at.why}); it is tried again when leaving runs`,
    );
  const step: LeaveStep = {
    title: authority
      ? `Remove ${d.node} from the fleet (as an authority, on ${d.branch})`
      : `Propose removing ${d.node} from the fleet (members cannot push to ${d.branch})`,
    lines: authority
      ? [
          `on origin's ${d.branch}: delete nodes/${d.node}.toml, drop ${d.node} from secrets/recipients.toml, re-encrypt the secrets for the others`,
          "checked under the sync lock against origin's current authorities, and again in the commit before it is pushed",
          `delete ${["state", "staging", "rejected"].map((k) => `${branchPrefix(k as "state")}${d.node}`).join(", ")}`,
        ]
      : [
          `propose on ${branchPrefix("staging")}${d.node}: delete nodes/${d.node}.toml, drop ${d.node} from secrets/recipients.toml and re-encrypt the secrets for the others`,
          "an authority approves it with t3-fleet approve, and re-encrypts the secrets from its own copy then",
        ],
    apply: leaveFleet(d.repo, d.branch, d.node, home).pipe(
      Effect.map((left) =>
        left._tag === "removed"
          ? [
              left.rev === null
                ? `${d.node} was already out of the fleet`
                : `${d.node} is out of the fleet (${left.rev})`,
              ...left.notes,
            ]
          : left.commit === null
            ? [`${d.node} was already out of the fleet`]
            : [
                `proposed ${left.commit}; on an authority run: t3-fleet approve ${d.node} ${left.commit}`,
              ],
      ),
    ),
  };
  return { step, refusal: null, notes };
};

/** What setup moved aside, and whether each goes back (only over T3 Fleet's link, or into nothing). */
const planBackups = (d: Departure, home: string, snapshot: SetupSnapshot | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const installed = installedTargets(d.settings, home, yield* repoRoots(d.repo));
    // Only over the very link T3 Fleet put there, or into nothing: a link of the user's own, even into the repo, stays.
    const restorable = (at: string) =>
      Effect.gen(function* () {
        const target = yield* linkTarget(at);
        if (Option.isSome(target)) return expectedTargets(installed, at).includes(target.value);
        return !(yield* fs.exists(at).pipe(Effect.orElseSucceed(() => true)));
      });
    const back: Array<{ at: string; backup: string }> = [];
    const kept: Array<{ at: string; backup: string }> = [];
    const notes: Array<string> = [];
    for (const m of snapshot?.moved ?? []) {
      const at = expandHome(m.path, home);
      const backup = expandHome(m.backup, home);
      // lstat, not exists: a backup that is a link to nothing is still the user's.
      if (!(yield* present(backup))) continue;
      if (yield* restorable(at)) back.push({ at, backup });
      else {
        kept.push({ at, backup });
        notes.push(
          `${tilde(at, home)} is your own now, so setup's backup of what was there before stays at ${tilde(backup, home)}`,
        );
      }
    }
    const step: LeaveStep | null =
      back.length === 0
        ? null
        : {
            title: "Put back what setup moved aside",
            lines: back.map(
              (b) => `$ mv ${shPath(tilde(b.backup, home))} ${shPath(tilde(b.at, home))}`,
            ),
            apply: Effect.forEach(back, (b) =>
              replaceWith({
                at: b.at,
                source: b.backup,
                how: "move",
                stillWanted: restorable(b.at),
              }).pipe(
                Effect.map((done) =>
                  done
                    ? null
                    : `${tilde(b.at, home)} changed meanwhile; its backup stays at ${tilde(b.backup, home)}`,
                ),
              ),
            ).pipe(
              Effect.map((skipped) => [
                `put back ${plural(back.length - skipped.filter(Boolean).length, "item")}`,
                ...skipped.filter((s): s is string => s !== null),
              ]),
            ),
          };
    return {
      step,
      kept,
      restoring: back,
      moved: (snapshot?.moved ?? []).map((m) => ({
        at: expandHome(m.path, home),
        backup: expandHome(m.backup, home),
      })),
      notes,
      skip: new Set((snapshot?.moved ?? []).map((m) => expandHome(m.path, home))),
    };
  });

/** Directories in the state dir that hold the user's own files: purge keeps them. */
export const KEPT = ["skill-backups", "setup-backups"];

/**
 * Purging. Every backup setup made that is still on disk when purge runs is
 * kept: whichever the plan expected to restore, a restore skipped because
 * the destination changed meanwhile leaves its backup, and that one is kept
 * too. They move to setup-backups, which purge never removes.
 */
const purgeStep = (
  home: string,
  moved: ReadonlyArray<{ readonly at: string; readonly backup: string }>,
  restoring: ReadonlySet<string>,
  snapshotReadable: boolean,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    const state = stateDir(home);
    const setupDir = `${state}/setup`;
    // The directories that hold the snapshot's backups, up to setup's own.
    const holders = new Set<string>();
    for (const m of moved)
      for (
        let d = path.dirname(m.backup);
        within(d, setupDir) && d !== setupDir;
        d = path.dirname(d)
      )
        holders.add(d);
    const notes: Array<string> = [];
    // Backups of the user's files that purge would otherwise take with the state dir.
    const rescued = moved
      .filter(
        (u) => within(u.backup, state) && !KEPT.some((k) => within(u.backup, `${state}/${k}`)),
      )
      .map((u) => ({ from: u.backup, to: `${state}/setup-backups/${path.basename(u.at)}` }));
    for (const r of rescued)
      if ((yield* present(r.from)) && !restoring.has(r.from))
        notes.push(`setup's backup ${tilde(r.from, home)} is kept, moved to ${tilde(r.to, home)}`);
    if (!snapshotReadable && (yield* present(setupDir)))
      notes.push(
        `setup's snapshot cannot be read, so ${tilde(setupDir, home)} is kept whole, moved into ${tilde(`${state}/setup-backups`, home)}`,
      );
    for (const k of KEPT)
      if (k !== "setup-backups" && (yield* exists(`${state}/${k}`)))
        notes.push(`kept ${tilde(`${state}/${k}`, home)}: your files from before joining`);
    const remove: Array<string> = [];
    if (yield* exists(configDir(home))) remove.push(configDir(home));
    for (const e of yield* fs
      .readDirectory(state)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      // The lock and the record of this departure go last; setup's directory is decided on when purge runs.
      if (!KEPT.includes(e) && e !== "sync.lock" && e !== "leave.json" && e !== "setup")
        remove.push(`${state}/${e}`);
    if (yield* exists(`${home}/${SHARE_DIR}`)) remove.push(`${home}/${SHARE_DIR}`);
    const command = `${home}/.local/bin/${CLI}`;
    if (yield* present(command)) remove.push(command);
    else
      notes.push(
        `${CLI} was not installed by its installer here (Homebrew or Nix?); uninstall it there`,
      );
    /** Moves `from` into setup-backups as `to`, or beside it under a free name; where it went. */
    const keep = (from: string, to: string) =>
      Effect.gen(function* () {
        let free = to;
        for (let i = 2; yield* present(free); i++) free = `${to}-${i}`;
        yield* fs.makeDirectory(path.dirname(free), { recursive: true });
        yield* fs.rename(from, free);
        return free;
      });
    const step: LeaveStep = {
      title:
        "Remove T3 Fleet's local state: this machine's key, the decrypted secrets, logs and the installed bundle",
      lines: [
        "every backup setup made that is still there moves to setup-backups first",
        `${tilde(setupDir, home)} is removed only if nothing but its snapshot is left in it; otherwise it moves to setup-backups whole`,
        ...remove.map((p) => `$ rm -rf ${shPath(tilde(p, home))}`),
      ],
      apply: Effect.gen(function* () {
        const done: Array<string> = [];
        for (const r of rescued)
          if (yield* present(r.from))
            done.push(`kept ${tilde(r.from, home)} as ${tilde(yield* keep(r.from, r.to), home)}`);
        // Decided from what is on disk, not from the snapshot: anything left but the snapshot is someone's.
        if (yield* present(setupDir)) {
          const left = (yield* leftUnder(setupDir, holders)).filter(
            (f) => f !== `${setupDir}/before.json`,
          );
          if (!snapshotReadable || left.length > 0)
            done.push(
              `kept ${tilde(setupDir, home)} whole as ${tilde(yield* keep(setupDir, `${state}/setup-backups/setup`), home)}${left.length > 0 ? `: it still holds ${plural(left.length, "thing")} the snapshot does not account for` : ""}`,
            );
          else yield* fs.remove(setupDir, { recursive: true, force: true });
        }
        for (const p of remove) yield* fs.remove(p, { recursive: true, force: true });
        return [...done, `removed ${plural(remove.length, "path")}`];
      }).pipe(Effect.mapError((e) => e.message)),
    };
    return { step, notes };
  });

/**
 * What is left under `dir` (not following links): every file and link, and
 * every directory that is not one of `holders`, the directories setup made
 * to hold the backups its snapshot lists (empty once those went back). An
 * empty directory nobody listed is someone's too.
 */
const leftUnder = (
  dir: string,
  holders: ReadonlySet<string>,
): Effect.Effect<Array<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: Array<string> = [];
    for (const name of yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))) {
      const at = `${dir}/${name}`;
      const isLink = Option.isSome(yield* fs.readLink(at).pipe(Effect.option));
      const info = yield* fs.stat(at).pipe(Effect.option);
      if (!isLink && Option.isSome(info) && info.value.type === "Directory") {
        if (!holders.has(at)) found.push(at);
        found.push(...(yield* leftUnder(at, holders)));
      } else found.push(at);
    }
    return found;
  });

/** What leaving does on this machine. Reads only, apart from fetching the config repo's origin. */
export const planLeave = (departure: Departure, options: LeaveOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = options.home;
    const d = departure;
    const platform = options.platform ?? process.platform;
    const root = options.root ?? process.getuid?.() === 0;
    const notes: Array<string> = [];
    // Who this machine is, as leave plans for it: its checkout gets its enrollment id now, if it had none.
    const identity = yield* currentIdentity(home, d.repo, true);
    const refuse = (refusal: string) =>
      ({
        departure: d,
        identity,
        home,
        purge: options.purge,
        refusal,
        steps: [],
        notes,
      }) satisfies LeavePlan;

    const services = yield* findServices(home, platform, options.systemDir, options.stopWait);
    const system = services.filter((s) => s.scope === "system");
    if (system.length > 0 && !root)
      return refuse(
        `T3 Fleet has system units here, which only root can stop. Run this, then leave again:\n${system
          .map((s) => `    sudo sh -c '${s.script.replaceAll("'", "'\\''")}'`)
          .join("\n")}`,
      );

    const steps: Array<LeaveStep> = [];
    if (!d.finished) {
      const at = yield* standing(d.repo, d.branch, d.node);
      const fleet = fleetStep(d, home, at);
      notes.push(...fleet.notes);
      if (fleet.refusal !== null) return refuse(fleet.refusal);
      if (fleet.step !== null) steps.push(fleet.step);
      if (d.roles.includes("relay"))
        notes.push(
          `${d.node} runs the fleet's relay: until another machine takes the relay role (and [relay] url points at it), the others lose the relay, its listeners and the MCP hub. On an authority, remove [relay] from t3-fleet.toml (or point its url elsewhere), and [defaults.mcp] hub and gateway if it hosted the MCP servers`,
        );
      const own = varNames(
        yield* fs.readFileString(localSecretsPath(home)).pipe(Effect.orElseSucceed(() => "")),
      ).filter((v) => v.endsWith(`_${d.node.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`));
      if (own.length > 0)
        notes.push(
          `secrets named for ${d.node} stay in the fleet (${own.join(", ")}); revoke them on an authority (t3-fleet mcp token revoke, t3-fleet secrets unset)`,
        );
    }

    const stopServices: LeaveStep | null =
      services.length === 0
        ? null
        : {
            title: `Stop and remove ${services.map((s) => s.what).join(", ")}`,
            lines: [
              "each is checked stopped before its unit is removed",
              ...services.flatMap((s) => s.script.split("\n")).map((l) => `$ ${l}`),
            ],
            apply: Effect.forEach(services, (s) => stopService(s, home)),
          };
    // T3's providers go back before the model proxy stops, so T3 never starts one through a stopped proxy.
    const models = yield* planModels(home);
    if (models.routed.length > 0 && models.t3._tag === "running" && models.t3.cli === null)
      return refuse(
        "T3 is running, but its CLI could not be found from the server's command line, so its providers cannot be pointed back through T3 while it runs; quit T3 and run leave again",
      );
    if (models.unreadable)
      notes.push(
        "T3's settings.json is not valid JSON, so model routing and the launchers are left as they are",
      );
    else if (models.routed.length + models.launchers.length > 0) {
      const how =
        models.t3._tag === "running"
          ? "through T3: each instance read with server.getSettings and sent back with server.updateSettings right after, over one connection and a two-minute session from `t3 auth session issue` (revoked afterwards); T3 takes an instance whole, so an edit to that instance in the moment between the two is lost"
          : "T3 is not running, so in ~/.t3/userdata/settings.json, only if nothing changes it meanwhile";
      steps.push({
        title: "Point T3's providers back at what they ran before, and remove the launchers",
        lines: [
          ...models.routed.map(
            (r) =>
              `${r.where === "legacy" ? `providers.${r.id}` : `providerInstances.${r.id}`}.binaryPath → ${r.restore ?? "T3's default"}`,
          ),
          ...(models.routed.length > 0 ? [how] : []),
          ...models.launchers
            .filter((l) => !models.stillUsed.includes(l))
            .map((l) => `$ rm ~/.local/bin/${l}   (once T3's settings no longer use it)`),
        ],
        apply: applyModels(home, models),
      });
      if (models.stillUsed.length > 0)
        notes.push(
          `T3 would still start a provider through ${models.stillUsed.join(", ")} after the restore, so it stays; point that provider elsewhere in T3's settings`,
        );
    }

    if (stopServices !== null) steps.push(stopServices);

    const snapshotText = yield* fs.readFileString(setupSnapshotPath(home)).pipe(Effect.option);
    const snapshot = Option.isSome(snapshotText)
      ? Option.getOrNull(decodeSnapshot(snapshotText.value))
      : null;
    if (Option.isSome(snapshotText) && snapshot === null)
      notes.push(`${tilde(setupSnapshotPath(home), home)} is not a setup snapshot; ignored`);
    const backups = yield* planBackups(d, home, snapshot);

    const links = yield* planLinks(
      d.repo,
      d.settings,
      home,
      backups.skip,
      backups.moved.map((m) => m.at),
    );
    for (const c of links.cycles)
      notes.push(
        `${tilde(c.at, home)} is left a link: ${tilde(c.loop, home)} inside it links back to a directory it is in, so a copy would never end`,
      );
    for (const b of links.broken)
      notes.push(
        `${tilde(b.at, home)} points into the config repo at ${tilde(b.target, home)}, which is gone; it is left as it is`,
      );
    for (const c of links.conversions)
      for (const inner of c.brokenInside)
        notes.push(
          `${tilde(inner, home)} points into the config repo at something gone; its copy keeps the link as it is`,
        );
    const linkCount = links.conversions.length + links.unfinished.length;
    if (linkCount > 0)
      steps.push({
        title: `Turn ${plural(linkCount, "link")} into the config repo into real copies`,
        lines: [
          "a directory cannot replace a link in one step: its link is moved aside and the copy renamed into place right after, and a run interrupted between the two is finished by the next",
          ...links.unfinished.map(
            (u) => `${tilde(u.marker.path, home)}  ← finish what an interrupted run left half-done`,
          ),
          ...links.conversions.map(
            (c) =>
              `${tilde(c.at, home)}  ← copy of ${tilde(c.target, home)}${c.nested > 0 ? ` (and ${plural(c.nested, "link")} into the repo inside it)` : ""}`,
          ),
        ],
        apply: Effect.gen(function* () {
          const kept: Array<string> = [];
          for (const u of links.unfinished) {
            const left = yield* finishUnfinished(u.dir, u.marker);
            if (left !== null) kept.push(left);
          }
          let changed = 0;
          for (const c of links.conversions) if (yield* convert(c, d.repo)) changed++;
          const skipped = links.conversions.length - changed;
          return [
            `copied ${plural(changed + links.unfinished.length - kept.length, "link")} into place`,
            ...kept,
            ...(skipped > 0
              ? [
                  `${plural(skipped, "link")} changed meanwhile and ${skipped === 1 ? "was" : "were"} left alone`,
                ]
              : []),
          ];
        }),
      });
    if (backups.step !== null) steps.push(backups.step);
    notes.push(...backups.notes);

    const mcp = yield* planMcp(
      home,
      d.repo,
      d.settings,
      snapshot === null
        ? null
        : {
            claude: snapshot.claude?.mcpServers ?? {},
            codex: snapshot.codex?.mcp_servers ?? {},
          },
    );
    notes.push(...mcp.notes);
    if (mcp.changes.length > 0)
      steps.push({
        title:
          snapshot === null
            ? "Remove T3 Fleet's own MCP server from Claude and Codex"
            : "Put back the MCP servers Claude and Codex had before setup",
        lines: mcp.changes.map((c) => c.line),
        apply: applyMcp(home, mcp),
      });

    if (options.purge) {
      const purge = yield* purgeStep(
        home,
        backups.moved,
        new Set(backups.restoring.map((b) => b.backup)),
        !(Option.isSome(snapshotText) && snapshot === null),
      );
      steps.push(purge.step);
      notes.push(...purge.notes);
    } else
      notes.push(
        `kept ${tilde(configDir(home), home)} (this machine's key and the decrypted secrets.env), ${tilde(stateDir(home), home)} and the installed ${CLI}; \`t3-fleet leave --purge\` removes them`,
      );
    notes.push(
      `the config repo checkout stays at ${tilde(d.repo, home)}; delete it yourself once you no longer need it`,
    );
    return {
      departure: d,
      identity,
      home,
      purge: options.purge,
      refusal: null,
      steps,
      notes,
    } satisfies LeavePlan;
  });

export interface LeaveOutcome {
  readonly title: string;
  readonly ok: boolean;
  readonly lines: ReadonlyArray<string>;
}

/**
 * Runs the plan's steps in order, holding the sync lock, and stops at the
 * first that fails; `t3-fleet leave` again picks up from there. The departure
 * is recorded first, and marked finished (or, with --purge, removed with the
 * rest of the state) once every step has run.
 */
export const applyLeave = (plan: LeavePlan) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { home } = plan;
    if (plan.refusal !== null) return [] as Array<LeaveOutcome>;
    const outcomes = yield* underSyncLock(
      Effect.gen(function* () {
        // Who this machine is was captured when it planned; anything changed since (a new key, a
        // new checkout) and the plan is not for this machine any more: nothing runs, nothing is recorded.
        const now = yield* currentIdentity(home, plan.departure.repo);
        const differs = [
          ...(plan.identity.node !== now.node
            ? [`it is ${now.node ?? "no node"} now, not ${plan.identity.node ?? "no node"}`]
            : []),
          ...identityChanges(plan.identity.enrollment, now.enrollment),
        ];
        if (differs.length > 0)
          return yield* Effect.fail(
            `this machine changed since leave planned (${differs.join("; ")}); nothing was done. Run t3-fleet leave again to plan for it as it is now.`,
          );
        const departure: Departure = {
          ...plan.departure,
          enrollment: plan.departure.enrollment ?? plan.identity.enrollment,
        };
        yield* writeDeparture(home, departure);
        const outcomes: Array<LeaveOutcome> = [];
        for (const step of plan.steps) {
          const result = yield* step.apply.pipe(Effect.result);
          if (result._tag === "Success")
            outcomes.push({ title: step.title, ok: true, lines: result.success });
          else {
            outcomes.push({ title: step.title, ok: false, lines: [result.failure] });
            break;
          }
        }
        if (outcomes.length === plan.steps.length && outcomes.every((o) => o.ok) && !plan.purge)
          yield* writeDeparture(home, { ...departure, finished: true });
        return outcomes;
      }),
    );
    if (plan.purge && outcomes.length === plan.steps.length && outcomes.every((o) => o.ok)) {
      // The lock is released; what is left of the state dir is the record, and the user's backups.
      yield* fs.remove(departurePath(home), { force: true }).pipe(Effect.ignore);
      const left = yield* fs
        .readDirectory(stateDir(home))
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      if (left.every((e) => !KEPT.includes(e)))
        yield* fs.remove(stateDir(home), { recursive: true, force: true }).pipe(Effect.ignore);
    }
    return outcomes;
  });
