/**
 * One sync run on this node: what the timer does every [fleet] interval.
 *
 *   1. propose  changes under [fleet] auto_commit paths (skills/, say): an
 *               authority commits them to the branch; any other node
 *               proposes them on t3-fleet/staging/<node> for approval
 *   2. pull     the branch, refusing when local edits overlap incoming files
 *               (a node whose pull failed proposes nothing that run)
 *   3. converge observe this node, diagnose it against the whole fleet's
 *               last reported state, and run its safe fixes in [fleet] apply
 *   4. report   this node's observation and findings to t3-fleet/state/<node>
 *   5. alert    record health transitions there too, for whoever relays them
 *
 * Every branch T3 Fleet writes belongs to one node, so pushes never race.
 * On the machine, a run holds the sync lock (SyncLock.ts), as does every
 * command that writes to the checkout.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { loadConfigFrom, probeSettings, type Config, type Node } from "./Config.ts";
import { diagnose, type Finding, type Fix } from "./Diagnose.ts";
import { runFixes } from "./Fix.ts";
import {
  addPaths,
  changedFiles,
  ensureGitConfig,
  git,
  literal,
  ok,
  out,
  pullBranch,
  scanStaged,
  why,
} from "./Git.ts";
import { allowCommand, describeHit, type SecretHit } from "./SecretScan.ts";
import { lookupLatest } from "./Latest.ts";
import { applyAccepted } from "./Memory.ts";
import { loadAreas } from "./Plugins.ts";
import { lastSyncPath, probeMachine } from "./Probe.ts";
import { NodeState, type Alert } from "./State.ts";
import type { NodeResult } from "./Remote.ts";
import { reportToRelay } from "./RelayClient.ts";
import { approve, autoApprovable, listProposals, settleRejection } from "./Staging.ts";
import { branchPrefix, stateDir } from "./Names.ts";
import { withSyncLock } from "./SyncLock.ts";

const decodeState = Schema.decodeEffect(Schema.fromJsonString(NodeState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(NodeState));

const DEFAULT_AUTO_COMMIT = ["skills"];
const DEFAULT_APPLY = [
  "engine",
  "secrets",
  "dotfiles",
  "instructions",
  "skills",
  "mcp",
  "agents",
  "t3",
];
const MAX_ALERTS = 50;

const settingList = (
  config: Config,
  key: "auto_commit" | "apply" | "auto_approve",
  fallback: ReadonlyArray<string>,
) => config.settings.fleet?.[key] ?? fallback;

/** All nodes' published state, from their t3-fleet/state/<node> branches. */
export const readStates = (repo: string) =>
  Effect.gen(function* () {
    const prefix = branchPrefix("state");
    yield* git(repo, [
      "fetch",
      "-q",
      "--prune",
      "origin",
      `+refs/heads/${prefix}*:refs/remotes/origin/${prefix}*`,
    ]);
    const refs = yield* git(repo, [
      "for-each-ref",
      "--format=%(refname:strip=3)",
      `refs/remotes/origin/${prefix}`,
    ]);
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
    const push = yield* git(repo, [
      "push",
      "-q",
      "--force",
      "origin",
      `${out(commit)}:refs/heads/${branchPrefix("state")}${state.node}`,
    ]);
    if (!ok(push)) return yield* Effect.fail(`publishing state: ${why(push)}`);
  });

/**
 * Propose `files` on t3-fleet/staging/<node>: one commit on top of the branch
 * tip with exactly these files, built in a scratch index so the working tree
 * and real index are untouched. No files: the proposal is withdrawn. A file
 * that adds what looks like a secret is left out, and returned in `blocked`.
 */
const propose = (repo: string, node: string, branch: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ref = `refs/heads/${branchPrefix("staging")}${node}`;
    const withdraw = Effect.gen(function* () {
      const exists = yield* git(repo, ["ls-remote", "--exit-code", "origin", ref]);
      if (ok(exists)) yield* git(repo, ["push", "-q", "origin", `:${ref}`]);
    });
    if (files.length === 0) {
      yield* withdraw;
      return { commit: null, files, blocked: [] as Array<SecretHit> };
    }
    // A scratch index: the working tree and the real index stay untouched.
    const env = { GIT_INDEX_FILE: `${repo}/.git/t3-fleet-propose-index`, ...literal };
    const read = yield* git(repo, ["read-tree", `origin/${branch}`], { env });
    if (!ok(read)) return yield* Effect.fail(`proposing: ${why(read)}`);
    const add = yield* git(repo, ["add", "-A", "--", ...files], { env });
    if (!ok(add)) return yield* Effect.fail(`proposing: ${why(add)}`);
    // A file adding what looks like a secret is left out, back at the branch's version.
    const blocked = yield* scanStaged(repo, { base: `origin/${branch}`, paths: files, env });
    const held = [...new Set(blocked.map((h) => h.file))];
    if (held.length > 0)
      yield* git(repo, ["reset", "-q", `origin/${branch}`, "--", ...held], { env });
    const kept = files.filter((f) => !held.includes(f));
    if (kept.length === 0) {
      yield* withdraw;
      return { commit: null, files: kept, blocked };
    }
    const tree = out(yield* git(repo, ["write-tree"], { env }));
    // The same change on the same base is already proposed: keep its commit, the one an authority may be reviewing.
    const existing = out(yield* git(repo, ["ls-remote", "origin", ref])).split(/\s+/)[0] ?? "";
    if (existing !== "" && ok(yield* git(repo, ["fetch", "-q", "origin", ref]))) {
      const [sameTree, sameBase] = [
        out(yield* git(repo, ["rev-parse", `${existing}^{tree}`])) === tree,
        out(yield* git(repo, ["rev-parse", `${existing}^`])) ===
          out(yield* git(repo, ["rev-parse", `origin/${branch}`])),
      ];
      if (sameTree && sameBase) return { commit: existing.slice(0, 7), files: kept, blocked };
    }
    const commit = yield* git(repo, [
      "commit-tree",
      tree,
      "-p",
      `origin/${branch}`,
      "-m",
      `Proposed by ${node}: ${kept.length} file${kept.length === 1 ? "" : "s"}\n\n${kept.join("\n")}`,
    ]);
    const push = yield* git(repo, ["push", "-q", "--force", "origin", `${out(commit)}:${ref}`]);
    if (!ok(push)) return yield* Effect.fail(`proposing: ${why(push)}`);
    return { commit: out(commit).slice(0, 7), files: kept, blocked };
  });

/** What sync would not commit or propose: one finding per file, naming lines and kinds, never values. */
const secretFindings = (
  node: string,
  hits: ReadonlyArray<SecretHit>,
  verb: string,
): Array<Finding> =>
  [...new Set(hits.map((h) => h.file))].map((file) => {
    const inFile = hits.filter((h) => h.file === file);
    return {
      node,
      key: `sync-secret-${file}`,
      severity: "error",
      area: "sync",
      title: `sync will not ${verb} ${file}: ${inFile.map((h) => describeHit(h).slice(file.length + 1)).join("; ")}`,
      detail: `Move the value into the fleet's secrets (t3-fleet secrets set NAME=VALUE on an authority) and refer to it as \${NAME}. If it is not a secret, an authority lets the line through: ${[...new Set(inFile.map(allowCommand))].join("; ")}`,
    };
  });

/**
 * A node's errors by finding key, with their titles. Keyed by the key alone:
 * a title that counts something ("failed 4 times") changes every run, and is
 * still the same problem.
 */
const healthOf = (findings: ReadonlyArray<Finding>) =>
  new Map(findings.filter((f) => f.severity === "error").map((f) => [f.key, f.title] as const));

/** The streak in this node's own record of its last run, which a failed publish cannot lose. */
const localStreak = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(lastSyncPath(home)).pipe(Effect.option);
    return Option.map(text, (t) => Number(t.split("\t")[2]) || 0);
  });

/**
 * Steps 1 and 2, the repo's part of a run: propose or commit, pull, push,
 * and on an authority approve what `auto_approve` trusts. Appends what it did
 * to `lines`; the config is the one pulled, and the findings are about the
 * repo on this node. Run holding the sync lock.
 */
export const exchange = (startConfig: Config, startSelf: Node, lines: Array<string>) =>
  Effect.gen(function* () {
    const repo = startConfig.repo;
    let config = startConfig;
    let self = startSelf;
    let message = "";
    let failed = false;
    const findings: Array<Finding> = [];

    // 1. Propose or commit changes under the auto-commit paths. A node
    //    whose last proposal was rejected first sets those edits aside.
    const autoCommit = settingList(config, "auto_commit", DEFAULT_AUTO_COMMIT);
    if (!self.roles.includes("authority")) {
      const settled = yield* settleRejection(repo, self.name, config.branch);
      if (settled.length > 0)
        lines.push(
          `set aside ${settled.length} rejected file${settled.length === 1 ? "" : "s"} (git stash list)`,
        );
    }
    if (self.roles.includes("authority") && autoCommit.length > 0) {
      // Exactly the changed files: an auto_commit path that does not exist would fail the whole add.
      const edited = yield* changedFiles(repo, autoCommit);
      // A file adding what looks like a secret stays an uncommitted edit, and a finding says why.
      yield* addPaths(repo, edited).pipe(Effect.ignore);
      const scanned =
        edited.length === 0 ? null : yield* scanStaged(repo, { paths: edited }).pipe(Effect.result);
      // Unscanned is uncommitted.
      if (scanned?._tag === "Failure") {
        failed = true;
        message = scanned.failure;
      }
      const blocked = scanned?._tag === "Success" ? scanned.success : [];
      const held = scanned?._tag === "Failure" ? edited : [...new Set(blocked.map((h) => h.file))];
      if (held.length > 0) {
        yield* git(repo, ["reset", "-q", "--", ...held], { env: literal });
        findings.push(...secretFindings(self.name, blocked, "commit"));
      }
      const changed = edited.filter((f) => !held.includes(f));
      if (changed.length > 0) {
        const committed = yield* addPaths(repo, changed).pipe(
          Effect.andThen(
            git(
              repo,
              [
                "commit",
                "-q",
                "-m",
                `Sync ${self.name}: ${changed.length} changed file${changed.length === 1 ? "" : "s"} under ${autoCommit.join(", ")}`,
                "--",
                ...changed,
              ],
              { env: literal },
            ),
          ),
          Effect.flatMap((commit) => (ok(commit) ? Effect.void : Effect.fail(why(commit)))),
          Effect.result,
        );
        if (committed._tag === "Success")
          lines.push(`committed ${changed.length} file${changed.length === 1 ? "" : "s"}`);
        else {
          failed = true;
          message = `committing ${changed.length} changed file${changed.length === 1 ? "" : "s"}: ${committed.failure}`;
        }
      }
    }

    // 2. Pull, then push what an authority committed. Any other node only
    //    fast-forwards: it never commits. Commits made there by hand are
    //    rebased along, as before, and named, since they reach no one.
    let how: "rebase" | "ff-only" = self.roles.includes("authority") ? "rebase" : "ff-only";
    if (how === "ff-only" && ok(yield* git(repo, ["fetch", "-q", "origin", config.branch]))) {
      const local = out(
        yield* git(repo, ["log", "--format=%h %s", `origin/${config.branch}..HEAD`]),
      )
        .split("\n")
        .filter(Boolean);
      if (local.length > 0) {
        how = "rebase";
        const some = local.length === 1 ? "a commit" : `${local.length} commits`;
        findings.push({
          node: self.name,
          key: "sync-local-commits",
          severity: "warn",
          area: "sync",
          title: `${some} here that ${config.branch} lacks (${local.slice(0, 3).join("; ")}${local.length > 3 ? "; …" : ""}): only an authority's commits reach the other machines`,
          detail: `git -C ${repo} reset --soft origin/${config.branch} turns them back into edits, which the next sync proposes for approval.`,
        });
      }
    }
    const pulled = yield* pullBranch(repo, config.branch, how).pipe(
      Effect.catch((e: string) =>
        Effect.sync(() => {
          failed = true;
          message = message || e;
          return 0;
        }),
      ),
    );
    if (pulled > 0) lines.push(`pulled ${pulled} commit${pulled === 1 ? "" : "s"}`);
    if (self.roles.includes("authority") && !failed) {
      const ahead = Number(
        out(yield* git(repo, ["rev-list", "--count", `origin/${config.branch}..HEAD`])),
      );
      if (ahead > 0) {
        const push = yield* git(repo, ["push", "-q", "origin", `HEAD:${config.branch}`]);
        if (ok(push)) lines.push(`pushed ${ahead} commit${ahead === 1 ? "" : "s"}`);
        else {
          failed = true;
          message = `push failed: ${why(push)}`;
        }
      }
    }

    // A non-authority proposes what still differs once it has pulled. Not
    // after a failed pull: its files would be based on an old branch, and
    // approving them would undo what it failed to pull.
    if (!self.roles.includes("authority") && !failed) {
      const changed = autoCommit.length === 0 ? [] : yield* changedFiles(repo, autoCommit);
      const proposal = yield* propose(repo, self.name, config.branch, changed).pipe(
        Effect.catch((e: string) =>
          Effect.sync(() => {
            failed = true;
            message = message || e;
            return null;
          }),
        ),
      );
      if (proposal !== null) {
        findings.push(...secretFindings(self.name, proposal.blocked, "propose"));
        if (proposal.commit !== null)
          lines.push(
            `proposed ${proposal.files.length} file${proposal.files.length === 1 ? "" : "s"} for approval (${proposal.commit})`,
          );
      }
    }

    // The pull may have changed the config; reload it.
    const reloaded = yield* loadConfigFrom(repo, config.self).pipe(Effect.option);
    if (Option.isSome(reloaded)) {
      config = reloaded.value;
      self = config.nodes.find((n) => n.name === config.self) ?? self;
    }

    // An authority approves proposals the config trusts without review.
    if (self.roles.includes("authority") && !failed) {
      const prefixes = settingList(config, "auto_approve", []);
      for (const proposal of yield* listProposals(repo, config.branch)) {
        if (!autoApprovable(proposal, prefixes)) continue;
        const rev = yield* approve(
          repo,
          config.branch,
          proposal,
          `${self.name}, automatically`,
          proposal.commit,
        ).pipe(
          Effect.catch((e: string) =>
            Effect.sync(() => {
              lines.push(`could not auto-approve ${proposal.node}'s proposal: ${e}`);
              return null;
            }),
          ),
        );
        if (rev !== null) lines.push(`approved ${proposal.node}'s proposal (${rev})`);
      }
    }

    return { failed, message, config, self, findings };
  });

/** What a run found and did, for its report. */
export interface Outcome {
  readonly config: Config;
  readonly node: string;
  readonly now: number;
  /** The node's last published state. */
  readonly previous: Option.Option<NodeState>;
  readonly failed: boolean;
  readonly message: string;
  readonly lines: Array<string>;
  /** This node's own findings. */
  readonly findings: ReadonlyArray<Finding>;
  readonly applied: NodeState["applied"];
  readonly observation: NodeState["observation"];
}

/**
 * Steps 4 and 5: publish the node's state, with alerts for health
 * transitions, and record the run locally once it is published. The streak
 * counts on from that local record, so a node that cannot publish still knows
 * it is failing, and says so in the record the probe reads.
 */
export const report = ({
  config,
  node,
  now,
  previous,
  failed,
  message,
  lines,
  findings,
  applied,
  observation,
}: Outcome) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    const repo = config.repo;
    const previousStreak = Option.getOrElse(yield* localStreak(home), () =>
      Option.match(previous, { onNone: () => 0, onSome: (p) => p.streak }),
    );
    const stateOf = (fail: boolean, reason: string): NodeState => {
      const streak = fail ? previousStreak + 1 : 0;
      const alerts: Array<Alert> = [
        ...Option.match(previous, { onNone: () => [], onSome: (p) => p.alerts }),
      ];
      const before = healthOf(
        Option.match(previous, {
          onNone: () => [] as Array<Finding>,
          onSome: (p) => p.findings as ReadonlyArray<Finding>,
        }),
      );
      const after = healthOf(findings);
      for (const [key, title] of after)
        if (!before.has(key)) alerts.push({ at: now, node, kind: "problem", message: title });
      for (const [key, title] of before)
        if (!after.has(key)) alerts.push({ at: now, node, kind: "resolved", message: title });
      const wasFailing = previousStreak >= config.alertAfter;
      if (streak >= config.alertAfter && !wasFailing)
        alerts.push({
          at: now,
          node,
          kind: "failing",
          message: `sync failed ${streak} times in a row: ${reason}`,
        });
      if (streak === 0 && wasFailing)
        alerts.push({ at: now, node, kind: "recovered", message: "sync works again" });
      return {
        node,
        at: now,
        result: fail ? "fail" : "ok",
        streak,
        message: reason || (lines.length === 0 ? "nothing to do" : lines.join("; ")),
        rev,
        observation,
        findings: findings.map((f) => ({
          node: f.node,
          key: f.key,
          severity: f.severity,
          area: f.area,
          title: f.title,
          ...(f.detail === undefined ? {} : { detail: f.detail }),
        })),
        applied,
        alerts: alerts.slice(-MAX_ALERTS),
      };
    };
    const record = (state: NodeState) =>
      fs
        .makeDirectory(stateDir(home), { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(
              lastSyncPath(home),
              `${Math.round(now / 1000)}\t${state.result}\t${state.streak}\t${state.message.replaceAll("\n", " ")}\n`,
            ),
          ),
          Effect.ignore,
        );
    const rev = out(yield* git(repo, ["rev-parse", "--short", "HEAD"]));
    const state = stateOf(failed, message);
    // Recorded only after publishing, so a run nobody else could see is never "ok" here.
    const published = yield* publishState(repo, state).pipe(
      Effect.mapError((e) => (typeof e === "string" ? e : `publishing state: ${e.message}`)),
      Effect.result,
    );
    if (published._tag === "Failure") {
      const unpublished = stateOf(
        true,
        message === "" ? published.failure : `${message}; ${published.failure}`,
      );
      yield* record(unpublished);
      yield* reportToRelay(config, unpublished).pipe(Effect.ignore);
      return yield* Effect.fail(published.failure);
    }
    yield* record(state);
    if (yield* reportToRelay(config, state)) lines.push("reported to the relay");
    return state;
  });

export interface SyncResult {
  readonly state: NodeState;
  readonly lines: ReadonlyArray<string>;
}

export const syncRun = (
  startConfig: Config,
  options: { readonly apply: boolean } = { apply: true },
) =>
  Effect.gen(function* () {
    const repo = startConfig.repo;
    // Reassigned after the pull: everything from observing on must judge this
    // node by the config it just pulled, not the one it started with.
    let config = startConfig;
    const found = config.nodes.find((n) => n.name === config.self);
    if (found === undefined) return yield* Effect.fail(`no node named ${config.self}`);
    let self: Node = found;
    const lines: Array<string> = [];
    const now = yield* Clock.currentTimeMillis;

    const run = Effect.gen(function* () {
      yield* ensureGitConfig;
      const previous = Option.fromNullishOr(
        (yield* readStates(repo)).find((s) => s.node === self.name),
      );
      const exchanged = yield* exchange(config, self, lines);
      let { failed, message } = exchanged;
      config = exchanged.config;
      self = exchanged.self;

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
            return node === undefined || s.observation === null
              ? []
              : [{ node, ok: true as const, observation: s.observation, ms: 0 }];
          }),
      ];
      const versions = (r: ReadonlyArray<NodeResult>) =>
        r
          .flatMap((x) =>
            x.ok
              ? [
                  x.observation.t3.descriptor?.serverVersion ??
                    x.observation.t3.installedVersion ??
                    "",
                ]
              : [],
          )
          .filter(Boolean);
      const findingsFor = (results: ReadonlyArray<NodeResult>) =>
        Effect.gen(function* () {
          const latest = yield* lookupLatest(versions(results));
          const { areas } = yield* loadAreas(repo, config.settings.plugins?.areas ?? []);
          // This node's findings, plus fixes other nodes need that must run here (an authority adding a node's key).
          return applyAccepted(
            diagnose(results, latest, config.settings, config.nodes, areas),
            config.settings.accept,
          ).filter((f) => f.node === self.name || f.fix?.on === self.name);
        });

      let selfResult = yield* observeSelf;
      let findings = yield* findingsFor(fleetResults(selfResult));
      const applyAreas = settingList(config, "apply", DEFAULT_APPLY);
      const applicable = findings.filter(
        (f): f is Finding & { readonly fix: Fix } =>
          f.fix !== undefined &&
          f.fix.safe &&
          (f.fix.on ?? f.node) === self.name &&
          applyAreas.includes(f.area),
      );
      const applied: Array<{ title: string; ok: boolean; output: string }> = [];
      if (options.apply && applicable.length > 0) {
        const outcomes = yield* runFixes([{ ...self, ssh: null }], applicable, repo);
        for (const o of outcomes)
          applied.push({ title: o.finding.title, ok: o.ok, output: o.summary });
        lines.push(
          ...outcomes.map((o) => `${o.ok ? "fixed" : "could not fix"}: ${o.finding.title}`),
        );
        selfResult = yield* observeSelf;
        findings = yield* findingsFor(fleetResults(selfResult));
      }
      if (applied.some((a) => !a.ok)) {
        failed = true;
        message = message || `a fix failed: ${applied.find((a) => !a.ok)?.title ?? ""}`;
      }

      // 4 and 5. Report, with alerts for health transitions.
      const state = yield* report({
        config,
        node: self.name,
        now,
        previous,
        failed,
        message,
        lines,
        findings: [...findings.filter((f) => f.node === self.name), ...exchanged.findings],
        applied,
        observation: selfResult.ok ? selfResult.observation : null,
      });
      return { state, lines };
    });

    // The fixes it runs are part of the run: an authority's `t3-fleet secrets add-node` must not wait for it.
    return yield* withSyncLock(
      run,
      Effect.succeed({ state: null, lines: ["another sync is running"] } as const),
      { children: true },
    );
  });

/** Run `effect` holding sync's lock, so no sync proposes or pulls the repo halfway through an edit. */
export { underSyncLock } from "./SyncLock.ts";

export { NodeState, type Alert } from "./State.ts";
