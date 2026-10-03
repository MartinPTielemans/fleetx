/**
 * One sync run on this node: what the timer does every [fleet] interval.
 *
 *   1. propose  changes under [fleet] auto_commit paths (skills/, say): an
 *               authority commits them to the branch; any other node
 *               proposes them on fleetx/staging/<node> for approval
 *   2. pull     the branch, refusing when local edits overlap incoming files
 *   3. converge observe this node, diagnose it against the whole fleet's
 *               last reported state, and run its safe fixes in [fleet] apply
 *   4. report   this node's observation and findings to fleetx/state/<node>
 *   5. alert    record health transitions there too, for whoever relays them
 *
 * Every branch fleetx writes belongs to one node, so pushes never race.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { probeSettings, type Config } from "./Config.ts";
import { diagnose, type Finding, type Fix } from "./Diagnose.ts";
import { runFixes } from "./Fix.ts";
import { ensureGitConfig, git, ok, out, why } from "./Git.ts";
import { lookupLatest } from "./Latest.ts";
import { applyAccepted } from "./Memory.ts";
import { MachineObservation } from "./Observation.ts";
import { probeMachine } from "./Probe.ts";
import type { NodeResult } from "./Remote.ts";
import { approve, autoApprovable, listProposals, settleRejection, STAGING } from "./Staging.ts";

export const STATE_PREFIX = "fleetx/state/";

const FindingRecord = Schema.Struct({
  node: Schema.String,
  key: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  area: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
});

const Alert = Schema.Struct({
  at: Schema.Number,
  node: Schema.String,
  kind: Schema.Literals(["failing", "recovered", "problem", "resolved"]),
  message: Schema.String,
});
export type Alert = typeof Alert.Type;

/** What a node publishes on fleetx/state/<node>. */
export const NodeState = Schema.Struct({
  node: Schema.String,
  at: Schema.Number,
  result: Schema.Literals(["ok", "fail"]),
  /** Failed runs in a row. */
  streak: Schema.Number,
  message: Schema.String,
  rev: Schema.String,
  observation: Schema.NullOr(MachineObservation),
  findings: Schema.Array(FindingRecord),
  applied: Schema.Array(Schema.Struct({ title: Schema.String, ok: Schema.Boolean, output: Schema.String })),
  /** Newest last; bounded. */
  alerts: Schema.Array(Alert),
});
export type NodeState = typeof NodeState.Type;

const decodeState = Schema.decodeEffect(Schema.fromJsonString(NodeState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(NodeState));

const DEFAULT_AUTO_COMMIT = ["skills"];
const DEFAULT_APPLY = ["engine", "secrets", "dotfiles", "instructions", "skills", "mcp", "agents"];
const MAX_ALERTS = 50;

const settingList = (config: Config, key: "auto_commit" | "apply" | "auto_approve", fallback: ReadonlyArray<string>) =>
  config.settings.fleet?.[key] ?? fallback;

/** All nodes' published state, from their fleetx/state/<node> branches. */
export const readStates = (repo: string) =>
  Effect.gen(function* () {
    yield* git(repo, ["fetch", "-q", "origin", `+refs/heads/${STATE_PREFIX}*:refs/remotes/origin/${STATE_PREFIX}*`]);
    const refs = yield* git(repo, ["for-each-ref", "--format=%(refname:strip=3)", `refs/remotes/origin/${STATE_PREFIX}`]);
    const states: Array<NodeState> = [];
    for (const ref of out(refs).split("\n").filter(Boolean)) {
      const show = yield* git(repo, ["show", `origin/${ref}:state.json`]);
      if (!ok(show)) continue;
      const state = yield* decodeState(show.stdout).pipe(Effect.option);
      if (Option.isSome(state)) states.push(state.value);
    }
    return states;
  });

/** Publish this node's state as the single commit on its state branch. */
const publishState = (repo: string, state: NodeState) =>
  Effect.gen(function* () {
    const json = yield* encodeState(state);
    const blob = yield* git(repo, ["hash-object", "-w", "--stdin"], { stdin: json });
    if (!ok(blob)) return yield* Effect.fail(`writing state: ${why(blob)}`);
    const tree = yield* git(repo, ["mktree"], { stdin: `100644 blob ${out(blob)}\tstate.json\n` });
    const commit = yield* git(repo, ["commit-tree", out(tree), "-m", `State of ${state.node}`]);
    const push = yield* git(repo, ["push", "-q", "--force", "origin", `${out(commit)}:refs/heads/${STATE_PREFIX}${state.node}`]);
    if (!ok(push)) return yield* Effect.fail(`publishing state: ${why(push)}`);
  });

/** Changed or new files under `paths`, as git sees them (ignored files excluded). */
const changedUnder = (repo: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (paths.length === 0) return [] as Array<string>;
    const status = yield* git(repo, ["status", "--porcelain", "-uall", "--", ...paths]);
    return out(status)
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).replace(/^.* -> /, ""));
  });

/**
 * Propose `files` on fleetx/staging/<node>: one commit on top of the branch
 * tip with exactly these files, built in a scratch index so the working tree
 * and real index are untouched. No files: the proposal is withdrawn.
 */
const propose = (repo: string, node: string, branch: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ref = `refs/heads/${STAGING}${node}`;
    if (files.length === 0) {
      const exists = yield* git(repo, ["ls-remote", "--exit-code", "origin", ref]);
      if (ok(exists)) yield* git(repo, ["push", "-q", "origin", `:${ref}`]);
      return null;
    }
    // A scratch index: the working tree and the real index stay untouched.
    const env = { GIT_INDEX_FILE: `${repo}/.git/fleetx-propose-index` };
    const read = yield* git(repo, ["read-tree", `origin/${branch}`], { env });
    if (!ok(read)) return yield* Effect.fail(`proposing: ${why(read)}`);
    yield* git(repo, ["add", "-A", "--", ...files], { env });
    const tree = yield* git(repo, ["write-tree"], { env });
    const commit = yield* git(repo, ["commit-tree", out(tree), "-p", `origin/${branch}`, "-m", `Proposed by ${node}: ${files.length} file${files.length === 1 ? "" : "s"}\n\n${files.join("\n")}`]);
    const push = yield* git(repo, ["push", "-q", "--force", "origin", `${out(commit)}:${ref}`]);
    if (!ok(push)) return yield* Effect.fail(`proposing: ${why(push)}`);
    return out(commit).slice(0, 7);
  });

/** Rebase onto origin, refusing when an uncommitted edit touches an incoming file. */
const pull = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const fetch = yield* git(repo, ["fetch", "-q", "origin", branch]);
    if (!ok(fetch)) return yield* Effect.fail(`fetch failed: ${why(fetch)}`);
    const behind = Number(out(yield* git(repo, ["rev-list", "--count", `HEAD..origin/${branch}`])));
    if (behind === 0) return 0;
    const status = out(yield* git(repo, ["status", "--porcelain", "-uall"])).split("\n").filter(Boolean);
    const dirty = new Map(status.map((l) => [l.slice(3).replace(/^.* -> /, ""), l.slice(0, 2)] as const));
    const incoming = out(yield* git(repo, ["diff", "--name-only", `HEAD...origin/${branch}`])).split("\n").filter(Boolean);
    const overlap: Array<string> = [];
    for (const file of incoming.filter((f) => dirty.has(f))) {
      // A local edit identical to what arrives (an approved proposal coming
      // back) is not a conflict: drop the local copy and take the branch's.
      const local = out(yield* git(repo, ["hash-object", "--", file]));
      const remote = out(yield* git(repo, ["rev-parse", `origin/${branch}:${file}`]));
      if (local !== "" && local === remote) {
        if (dirty.get(file) === "??") yield* git(repo, ["clean", "-q", "-f", "--", file]);
        else yield* git(repo, ["checkout", "-q", "HEAD", "--", file]);
        continue;
      }
      overlap.push(file);
    }
    if (overlap.length > 0) return yield* Effect.fail(`local edits overlap incoming changes: ${overlap.join(", ")}`);
    const rebase = yield* git(repo, ["rebase", "-q", "--autostash", `origin/${branch}`]);
    if (!ok(rebase)) {
      yield* git(repo, ["rebase", "--abort"]);
      return yield* Effect.fail(`rebase onto origin/${branch} conflicted; resolve by hand`);
    }
    return behind;
  });

const healthOf = (findings: ReadonlyArray<Finding>) => new Set(findings.filter((f) => f.severity === "error").map((f) => `${f.key}\t${f.title}`));

export interface SyncResult {
  readonly state: NodeState;
  readonly lines: ReadonlyArray<string>;
}

export const syncRun = (config: Config, options: { readonly apply: boolean } = { apply: true }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    const repo = config.repo;
    const self = config.nodes.find((n) => n.name === config.self);
    if (self === undefined) return yield* Effect.fail(`no node named ${config.self}`);
    const lines: Array<string> = [];
    const now = yield* Clock.currentTimeMillis;

    // One run at a time; a lock older than an hour belongs to a dead run.
    const lock = `${home}/.local/state/fleetx/sync.lock`;
    yield* fs.makeDirectory(`${home}/.local/state/fleetx`, { recursive: true }).pipe(Effect.ignore);
    const lockStat = yield* fs.stat(lock).pipe(Effect.option);
    if (Option.isSome(lockStat)) {
      const age = Option.match(lockStat.value.mtime, { onNone: () => Infinity, onSome: (t) => now - t.getTime() });
      if (age < 3_600_000) return { state: null, lines: ["another sync is running"] } as const;
      yield* fs.remove(lock, { recursive: true }).pipe(Effect.ignore);
    }
    yield* fs.makeDirectory(lock).pipe(Effect.ignore);

    const run = Effect.gen(function* () {
      yield* ensureGitConfig;
      const previous = Option.fromNullishOr((yield* readStates(repo)).find((s) => s.node === self.name));
      let message = "";
      let failed = false;

      // 1. Propose or commit changes under the auto-commit paths. A node
      //    whose last proposal was rejected first sets those edits aside.
      const autoCommit = settingList(config, "auto_commit", DEFAULT_AUTO_COMMIT);
      if (!self.roles.includes("authority")) {
        const settled = yield* settleRejection(repo, self.name, config.branch);
        if (settled.length > 0) lines.push(`set aside ${settled.length} rejected file${settled.length === 1 ? "" : "s"} (git stash list)`);
      }
      if (self.roles.includes("authority")) {
        const changed = yield* changedUnder(repo, autoCommit);
        if (changed.length > 0) {
          yield* git(repo, ["add", "-A", "--", ...autoCommit]);
          const commit = yield* git(repo, ["commit", "-q", "-m", `Sync ${self.name}: ${changed.length} changed file${changed.length === 1 ? "" : "s"} under ${autoCommit.join(", ")}`, "--", ...autoCommit]);
          if (ok(commit)) lines.push(`committed ${changed.length} file${changed.length === 1 ? "" : "s"}`);
        }
      }

      // 2. Pull, then push what an authority committed.
      const pulled = yield* pull(repo, config.branch).pipe(
        Effect.catch((e: string) => Effect.sync(() => {
          failed = true;
          message = message || e;
          return 0;
        })),
      );
      if (pulled > 0) lines.push(`pulled ${pulled} commit${pulled === 1 ? "" : "s"}`);
      if (self.roles.includes("authority") && !failed) {
        const ahead = Number(out(yield* git(repo, ["rev-list", "--count", `origin/${config.branch}..HEAD`])));
        if (ahead > 0) {
          const push = yield* git(repo, ["push", "-q", "origin", `HEAD:${config.branch}`]);
          if (ok(push)) lines.push(`pushed ${ahead} commit${ahead === 1 ? "" : "s"}`);
          else {
            failed = true;
            message = `push failed: ${why(push)}`;
          }
        }
      }

      // A non-authority proposes what still differs once it has pulled.
      if (!self.roles.includes("authority")) {
        const changed = yield* changedUnder(repo, autoCommit);
        const proposal = yield* propose(repo, self.name, config.branch, changed).pipe(
          Effect.catch((e: string) => Effect.sync(() => {
            failed = true;
            message = message || e;
            return null;
          })),
        );
        if (proposal !== null) lines.push(`proposed ${changed.length} file${changed.length === 1 ? "" : "s"} for approval (${proposal})`);
      }

      // An authority approves proposals the config trusts without review.
      if (self.roles.includes("authority") && !failed) {
        const prefixes = settingList(config, "auto_approve", []);
        for (const proposal of yield* listProposals(repo, config.branch)) {
          if (!autoApprovable(proposal, prefixes)) continue;
          const rev = yield* approve(repo, config.branch, proposal, `${self.name}, automatically`).pipe(
            Effect.catch((e: string) => Effect.sync(() => {
              lines.push(`could not auto-approve ${proposal.node}'s proposal: ${e}`);
              return null;
            })),
          );
          if (rev !== null) lines.push(`approved ${proposal.node}'s proposal (${rev})`);
        }
      }

      // 3. Observe, diagnose against everyone's last state, apply safe fixes.
      const others = yield* readStates(repo);
      const observeSelf = probeMachine(probeSettings(config, self)).pipe(
        Effect.map((observation): NodeResult => ({ node: self, ok: true, observation, ms: 0 })),
      );
      const fleetResults = (selfResult: NodeResult): Array<NodeResult> => [
        selfResult,
        ...others
          .filter((s) => s.node !== self.name && s.observation !== null)
          .flatMap((s) => {
            const node = config.nodes.find((n) => n.name === s.node);
            return node === undefined || s.observation === null ? [] : [{ node, ok: true as const, observation: s.observation, ms: 0 }];
          }),
      ];
      const versions = (r: ReadonlyArray<NodeResult>) =>
        r.flatMap((x) => (x.ok ? [x.observation.t3.descriptor?.serverVersion ?? x.observation.t3.installedVersion ?? ""] : [])).filter(Boolean);
      const findingsFor = (results: ReadonlyArray<NodeResult>) =>
        Effect.gen(function* () {
          const latest = yield* lookupLatest(versions(results));
          // This node's findings, plus fixes other nodes need that must run here (an authority adding a node's key).
          return applyAccepted(diagnose(results, latest, config.settings, config.nodes), config.settings.accept).filter(
            (f) => f.node === self.name || f.fix?.on === self.name,
          );
        });

      let selfResult = yield* observeSelf;
      let findings = yield* findingsFor(fleetResults(selfResult));
      const applyAreas = settingList(config, "apply", DEFAULT_APPLY);
      const applicable = findings.filter(
        (f): f is Finding & { readonly fix: Fix } =>
          f.fix !== undefined && f.fix.safe && (f.fix.on ?? f.node) === self.name && applyAreas.includes(f.area),
      );
      const applied: Array<{ title: string; ok: boolean; output: string }> = [];
      if (options.apply && applicable.length > 0) {
        const outcomes = yield* runFixes([{ ...self, ssh: null }], applicable, config.checkout);
        for (const o of outcomes) applied.push({ title: o.finding.title, ok: o.ok, output: o.summary });
        lines.push(...outcomes.map((o) => `${o.ok ? "fixed" : "could not fix"}: ${o.finding.title}`));
        selfResult = yield* observeSelf;
        findings = yield* findingsFor(fleetResults(selfResult));
      }
      if (applied.some((a) => !a.ok)) {
        failed = true;
        message = message || `a fix failed: ${applied.find((a) => !a.ok)?.title ?? ""}`;
      }

      // 4 and 5. Report, with alerts for health transitions.
      const streak = failed ? Option.match(previous, { onNone: () => 0, onSome: (p) => p.streak }) + 1 : 0;
      const alerts: Array<Alert> = [...Option.match(previous, { onNone: () => [], onSome: (p) => p.alerts })];
      const before = healthOf(Option.match(previous, { onNone: () => [] as Array<Finding>, onSome: (p) => p.findings as ReadonlyArray<Finding> }));
      const after = healthOf(findings.filter((f) => f.node === self.name));
      for (const problem of after) if (!before.has(problem)) alerts.push({ at: now, node: self.name, kind: "problem", message: problem.split("\t")[1] ?? problem });
      for (const problem of before) if (!after.has(problem)) alerts.push({ at: now, node: self.name, kind: "resolved", message: problem.split("\t")[1] ?? problem });
      const wasFailing = Option.match(previous, { onNone: () => false, onSome: (p) => p.streak >= config.alertAfter });
      if (streak >= config.alertAfter && !wasFailing) alerts.push({ at: now, node: self.name, kind: "failing", message: `sync failed ${streak} times in a row: ${message}` });
      if (streak === 0 && wasFailing) alerts.push({ at: now, node: self.name, kind: "recovered", message: "sync works again" });

      const state: NodeState = {
        node: self.name,
        at: now,
        result: failed ? "fail" : "ok",
        streak,
        message: message || (lines.length === 0 ? "nothing to do" : lines.join("; ")),
        rev: out(yield* git(repo, ["rev-parse", "--short", "HEAD"])),
        observation: selfResult.ok ? selfResult.observation : null,
        findings: findings.filter((f) => f.node === self.name).map((f) => ({ node: f.node, key: f.key, severity: f.severity, area: f.area, title: f.title, ...(f.detail === undefined ? {} : { detail: f.detail }) })),
        applied,
        alerts: alerts.slice(-MAX_ALERTS),
      };
      yield* publishState(repo, state);
      return { state, lines };
    });

    return yield* run.pipe(Effect.ensuring(fs.remove(lock, { recursive: true }).pipe(Effect.ignore)));
  });

