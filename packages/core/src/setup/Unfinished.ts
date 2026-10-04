/**
 * A setup dropped with --abandon leaves what it did in place: files written
 * into the checkout but not yet published (or proposed), links made but no
 * first sync, so servers it added are declared but registered nowhere.
 * Discovery cannot see any of that: the fleet it compares with is the
 * checkout, which already has the run's files.
 *
 * So --abandon records the run (State.recordAbandoned) and says what it had
 * done and how to finish or undo it, and the next setup finishes it: it
 * publishes what the run wrote (an authority) or marks it for proposing (a
 * member), and syncs when no sync has completed since.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { lastProposalPath } from "../Approved.ts";
import { changedFiles, commitAndPush, git, nulList, ok, out } from "../Git.ts";
import { lastSyncPath } from "../Probe.ts";
import { firstSync, pushLeftover } from "./Apply.ts";
import {
  addSetupProposed,
  backupDir,
  clearAbandoned,
  snapshotPath,
  type Abandoned,
} from "./State.ts";

const t = (home: string, p: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

const DONE: Readonly<Record<string, (a: Abandoned, home: string) => string>> = {
  snapshot: (_, home) => `saved the clients' MCP servers in ${t(home, snapshotPath(home))}`,
  repo: (a) => `created the fleet's repo at ${a.checkout}`,
  clone: (a) => `cloned the fleet to ${a.checkout}`,
  content: (a) => `wrote its skills, servers and files into ${a.checkout}`,
  keys: () => "made this machine's key and stored the secrets",
  commit: () => "committed and pushed them",
  config: () => "wrote ~/.config/t3-fleet/config.toml (this machine and its repo)",
  links: (a, home) =>
    `linked skills and instructions from the checkout; what was there is in ${t(home, `${backupDir(home)}/${a.startedAt}`)}`,
  t3: () => "connected T3 Fleet to T3",
  sync: () => "ran a first sync",
};

/** What --abandon says: what the run did, what it did not, and how to finish or undo it. */
export const abandonReport = (
  a: Abandoned,
  steps: ReadonlyArray<string>,
  home: string,
): ReadonlyArray<string> => {
  const left = steps.filter((s) => !a.done.includes(s));
  const lines = [`Dropped the unfinished setup of ${a.node}. What it did stays:`];
  if (a.done.length === 0) lines.push("  nothing: it stopped before its first step");
  for (const s of a.done) lines.push(`  ✓ ${DONE[s]?.(a, home) ?? s}`);
  if (left.length > 0) lines.push(`Not done: ${left.join(", ")}.`);
  if (a.done.length === 0) return lines;
  const wrote = a.done.includes("content");
  const published = a.done.includes("commit") || a.done.includes("sync");
  lines.push(
    "To finish it: run `t3-fleet setup` again. It " +
      [
        ...(wrote && !published
          ? [a.commits ? "publishes what this run wrote" : "proposes what this run wrote"]
          : []),
        ...(a.done.includes("sync") ? [] : ["runs the first sync, which registers its servers"]),
      ].join(" and ") +
      ", then shows anything else that still differs.",
  );
  const undo: Array<string> = [];
  if (wrote && !a.done.includes("commit"))
    undo.push(
      `\`git -C ${a.checkout} status -- ${a.written.join(" ")}\` shows what it wrote; \`git -C ${a.checkout} checkout -- <file>\` puts a changed file back, and a new one can be deleted`,
    );
  if (a.done.includes("commit"))
    undo.push(`revert its "Set up ${a.node}" commit in ${a.checkout}, and push`);
  if (a.done.includes("links"))
    undo.push(
      `the links: each original is in ${t(home, `${backupDir(home)}/${a.startedAt}`)}, and ${t(home, snapshotPath(home))} lists every move`,
    );
  if (a.done.includes("config"))
    undo.push("~/.config/t3-fleet/config.toml: remove it, and this machine is in no fleet");
  if (undo.length > 0) lines.push("To undo it instead:", ...undo.map((u) => `  ${u}`));
  return lines;
};

/** What an abandoned run left to do here: files to publish or propose, and a sync. */
export interface Unfinished {
  readonly publish: ReadonlyArray<string>;
  /** Files in commits here the remote lacks (a push that failed). */
  readonly unpushed: ReadonlyArray<string>;
  readonly propose: ReadonlyArray<string>;
  readonly sync: boolean;
}

export const nothingUnfinished = (u: Unfinished) =>
  u.publish.length + u.unpushed.length + u.propose.length === 0 && !u.sync;

/** Read-only: compares the record with the checkout and the last sync. */
export const unfinishedWork = (home: string, a: Abandoned, authority: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const changed = yield* changedFiles(a.checkout, a.written);
    // A member's proposal as sync last made it (Sync.ts records its commit).
    const proposal = Option.getOrNull(
      yield* fs.readFileString(lastProposalPath(home)).pipe(
        Effect.map((text) => text.trim()),
        Effect.option,
      ),
    );
    const publish: Array<string> = [];
    const propose: Array<string> = [];
    for (const file of changed) {
      if (authority) {
        publish.push(file);
        continue;
      }
      // Proposed already, as it is: waiting for an authority, which is not unfinished.
      const local = out(yield* git(a.checkout, ["hash-object", "--", file]));
      const there =
        proposal === null
          ? null
          : yield* git(a.checkout, ["rev-parse", "-q", "--verify", `${proposal}:${file}`]);
      if (there === null || !ok(there) || out(there) !== local) propose.push(file);
    }
    const unpushed =
      authority &&
      ok(yield* git(a.checkout, ["rev-parse", "-q", "--verify", "origin/main"])) &&
      out(yield* git(a.checkout, ["rev-list", "--count", "origin/main..HEAD"])) !== "0"
        ? nulList(
            (yield* git(a.checkout, ["diff", "--name-only", "-z", "origin/main...HEAD"])).stdout,
          )
        : [];
    const last = yield* fs.readFileString(lastSyncPath(home)).pipe(Effect.option);
    const [when = "0", result = ""] = Option.getOrElse(last, () => "")
      .trim()
      .split("\t");
    const sync = Number(when) * 1000 < a.abandonedAt || result !== "ok";
    return { publish, unpushed, propose, sync } satisfies Unfinished;
  });

const aheadOfOrigin = (repo: string) =>
  git(repo, ["rev-list", "--count", "origin/main..HEAD"]).pipe(Effect.map((r) => out(r) !== "0"));

export const unfinishedLines = (u: Unfinished, a: Abandoned): ReadonlyArray<string> => [
  ...(u.publish.length > 0 ? [`not published: ${u.publish.join(", ")}`] : []),
  ...(u.unpushed.length > 0 ? [`committed here, not pushed: ${u.unpushed.join(", ")}`] : []),
  ...(u.propose.length > 0 ? [`not proposed: ${u.propose.join(", ")}`] : []),
  ...(u.sync
    ? [
        `no sync has completed since it ${a.done.length > 0 ? "stopped" : "started"}: the servers it added are registered by one`,
      ]
    : []),
];

/**
 * Finish it: publish (through commitAndPush, scanned) or mark for proposing
 * what the run wrote; then, when `sync`, the first sync. The record goes once
 * all of that is done.
 */
export const finishWork = (
  home: string,
  a: Abandoned,
  u: Unfinished,
  options: { readonly sync: boolean },
) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    if (u.publish.length > 0) {
      const rev = yield* commitAndPush(a.checkout, u.publish, `Set up ${a.node}`);
      lines.push(`published ${u.publish.join(", ")} (${rev})`);
    }
    // commitAndPush pushed them along; with nothing to commit, they go on their own (scanned).
    if (u.unpushed.length > 0 && (u.publish.length === 0 || (yield* aheadOfOrigin(a.checkout))))
      lines.push(`${yield* pushLeftover(a.checkout)}: ${u.unpushed.join(", ")}`);
    if (u.propose.length > 0) {
      yield* addSetupProposed(home, u.propose);
      lines.push(`marked ${u.propose.join(", ")} for proposing`);
    }
    if (options.sync && (u.sync || u.propose.length > 0))
      lines.push(...(yield* firstSync(a.checkout)));
    yield* clearAbandoned(home);
    return lines;
  });
