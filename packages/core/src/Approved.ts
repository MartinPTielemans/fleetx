/**
 * On a proposing node, just before it pulls: its own copies of files the
 * branch has changed. Every machine that joins with setup edits
 * t3-fleet.toml, so two joining machines meet this whether the first is
 * approved or not.
 *
 *   - a copy of a file approved from this node, the same as it proposed
 *     (its last proposal commit): it is what was approved;
 *   - a copy edited since it was proposed, or not approved and overlapping
 *     someone else's change, that merges with the branch's version (text
 *     with git merge-file, setup's TOML list additions with TomlMerge);
 *   - an approved file edited since that does not merge: the branch's
 *     version is taken, and the edit is kept for the user, named.
 *
 * Each of those is saved under ~/.local/state/t3-fleet/approved/<time>/ (mode
 * 600) before its copy is put back to HEAD for the pull. When the pull fails,
 * every saved copy goes back exactly as it was (restoreHeld); when it
 * succeeds, merges are written over the branch's version and only the copies
 * the user must look at are kept. Anything else (including what sync holds
 * back for a secret) is left alone, and the pull refuses as it always has,
 * with the step that gets past it. Nothing goes to the shared `git stash`.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { exec } from "./Exec.ts";
import { changedFiles, git, literal, nulList, ok, out } from "./Git.ts";
import { stateDir } from "./Names.ts";
import { mergeAdditions } from "./setup/TomlMerge.ts";
import { underSyncLock } from "./SyncLock.ts";

/** Where this node records its last proposal's commit (Sync.ts writes it). */
export const lastProposalPath = (home: string) => `${stateDir(home)}/last-proposal`;

/** Where copies are kept: one directory per sync that kept any. */
export const approvedDir = (home: string) => `${stateDir(home)}/approved`;

/** Kept copies older than this, or beyond this many syncs' worth, are removed. */
const KEEP_DAYS = 30;
const KEEP_RUNS = 20;

/** The files approvals of `node`'s proposals name (the approve commit lists them). */
export const approvedFiles = (log: string, node: string) => {
  const files = new Set<string>();
  for (const entry of log.split("\u001e")) {
    const [subject = "", ...body] = entry.trim().split("\n");
    if (!subject.startsWith(`Approve ${node}'s proposal`)) continue;
    for (const line of body) if (line.trim() !== "") files.add(line.trim());
  }
  return [...files];
};

/** A copy put back to HEAD for the pull. */
export interface Held {
  readonly file: string;
  /** The saved copy, exactly as it was. */
  readonly saved: string;
  /**
   *   proposed  it was what was approved: nothing to write back
   *   merged    the edit on top of the branch's version, written after the pull
   *   kept      an approved file edited since that does not merge: the copy stays saved
   */
  readonly outcome: "proposed" | "merged" | "kept";
  readonly merged: string | null;
}

/** Put the copy back to what the checkout's HEAD has (or remove it, when HEAD lacks it). */
const dropLocal = (repo: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (ok(yield* git(repo, ["cat-file", "-e", `HEAD:${file}`])))
      yield* git(repo, ["checkout", "-q", "HEAD", "--", file], { env: literal });
    else yield* fs.remove(`${repo}/${file}`, { force: true }).pipe(Effect.ignore);
  });

/**
 * `ours` with what changed from `base` to `theirs`, or null when they do not
 * merge. TOML falls back to setup's list additions, measured from `shared`,
 * the version both sides started from.
 */
const merge3 = (
  file: string,
  base: string,
  shared: string | null,
  ours: string,
  theirs: string,
  now: number,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${process.env["TMPDIR"] ?? "/tmp"}/t3-fleet-merge-${now}-${process.pid}`;
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    const [b, o, t] = [`${dir}/base`, `${dir}/ours`, `${dir}/theirs`];
    const merged = yield* Effect.gen(function* () {
      yield* fs.writeFileString(b, base, { mode: 0o600 });
      yield* fs.writeFileString(o, ours, { mode: 0o600 });
      yield* fs.writeFileString(t, theirs, { mode: 0o600 });
      // In its own directory, looking for no repository above it: whatever the
      // process's directory is (a broken worktree's .git, say), it is not in play.
      return yield* exec({
        command: "git",
        args: ["-C", dir, "merge-file", "-p", "ours", "base", "theirs"],
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_CEILING_DIRECTORIES: dir.slice(0, dir.lastIndexOf("/")),
        },
        timeout: Duration.seconds(30),
      });
    }).pipe(Effect.ensuring(fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)));
    if (merged.code === 0) return merged.stdout;
    return file.endsWith(".toml") && shared !== null ? mergeAdditions(shared, theirs, ours) : null;
  });

/** Old copies removed: by age, then all but the newest few. */
const prune = (home: string, now: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runs = (yield* fs
      .readDirectory(approvedDir(home))
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter((n) => /^\d+$/.test(n))
      .sort((a, b) => Number(b) - Number(a));
    for (const [i, run] of runs.entries())
      if (i >= KEEP_RUNS || now - Number(run) > KEEP_DAYS * 86_400_000)
        yield* fs.remove(`${approvedDir(home)}/${run}`, { recursive: true }).pipe(Effect.ignore);
  });

/**
 * Settle this node's copies before the pull, against origin/<branch> as
 * already fetched. `exclude`: files sync holds back for a secret. Returns
 * what it put back to HEAD (`held`), and the overlapping files it left
 * alone because they do not merge (`refused`).
 */
export const settleApproval = (
  repo: string,
  node: string,
  branch: string,
  exclude: ReadonlySet<string> = new Set(),
) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = process.env["HOME"] ?? "";
      const now = yield* Clock.currentTimeMillis;
      yield* prune(home, now);
      const log = yield* git(repo, ["log", "--format=%s%n%b%x1e", `HEAD..origin/${branch}`]);
      const approved = approvedFiles(log.stdout, node);
      const incoming = nulList(
        (yield* git(repo, ["diff", "--name-only", "-z", "--no-renames", `HEAD...origin/${branch}`]))
          .stdout,
      );
      const files = [...new Set([...approved, ...incoming])].filter((f) => !exclude.has(f));
      const held: Array<Held> = [];
      const refused: Array<string> = [];
      if (files.length === 0) return { held, refused };
      const proposal = Option.getOrNull(
        yield* fs.readFileString(lastProposalPath(home)).pipe(
          Effect.map((t) => t.trim()),
          Effect.option,
        ),
      );
      const blob = (rev: string, file: string) =>
        git(repo, ["rev-parse", "-q", "--verify", `${rev}:${file}`]).pipe(Effect.map(out));
      const show = (rev: string, file: string) =>
        git(repo, ["show", `${rev}:${file}`]).pipe(Effect.map((r) => (ok(r) ? r.stdout : null)));
      const saveDir = `${approvedDir(home)}/${now}`;
      for (const file of (yield* changedFiles(repo, files)).filter((f) => !exclude.has(f))) {
        const exists = yield* fs.exists(`${repo}/${file}`).pipe(Effect.orElseSucceed(() => false));
        // A deletion here, or a file the branch already has as it is: the pull handles it.
        if (!exists) continue;
        const local = out(yield* git(repo, ["hash-object", "--", file], { env: literal }));
        if (local === (yield* blob(`origin/${branch}`, file))) continue;
        const wasApproved = approved.includes(file);
        let outcome: Held["outcome"];
        let merged: string | null = null;
        if (wasApproved && proposal !== null && local === (yield* blob(proposal, file)))
          outcome = "proposed";
        else {
          const baseRev = wasApproved && proposal !== null ? proposal : "HEAD";
          const [base, theirs] = [
            yield* show(baseRev, file),
            yield* show(`origin/${branch}`, file),
          ];
          const ours = yield* fs.readFileString(`${repo}/${file}`);
          const shared = yield* show("HEAD", file);
          merged =
            base !== null && theirs !== null
              ? yield* merge3(file, base, shared, ours, theirs, now)
              : null;
          if (merged !== null) outcome = "merged";
          else if (wasApproved) outcome = "kept";
          else {
            refused.push(file);
            continue;
          }
        }
        // Saved before anything changes; a failed pull puts it back from here.
        const saved = `${saveDir}/${file}`;
        yield* fs.makeDirectory(saved.slice(0, saved.lastIndexOf("/")), {
          recursive: true,
          mode: 0o700,
        });
        yield* fs.copyFile(`${repo}/${file}`, saved);
        yield* fs.chmod(saved, 0o600);
        held.push({ file, saved, outcome, merged });
        yield* dropLocal(repo, file);
      }
      return { held, refused };
    }).pipe(Effect.mapError((e) => `setting aside this machine's edits: ${e.message}`)),
  );

/** The pull failed: every copy goes back exactly as it was, and its saved copy goes. */
export const restoreHeld = (repo: string, held: ReadonlyArray<Held>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const h of held) {
      yield* fs.copyFile(h.saved, `${repo}/${h.file}`);
      yield* fs.remove(h.saved).pipe(Effect.ignore);
    }
    yield* removeEmpty(held);
  }).pipe(Effect.mapError((e) => `putting this machine's edits back: ${e.message}`));

/** After the pull: merges written over the branch's version; only copies the user must look at stay. */
export const reapplyHeld = (repo: string, held: ReadonlyArray<Held>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines: Array<string> = [];
    for (const h of held) {
      if (h.outcome === "kept") {
        lines.push(
          `this machine's edit to ${h.file} does not fit the approved version; the branch's stays, the edit is in ${h.saved}`,
        );
        continue;
      }
      if (h.merged !== null) {
        yield* fs.writeFileString(`${repo}/${h.file}`, h.merged);
        lines.push(`kept this machine's edit to ${h.file}, on top of the branch's version`);
      }
      yield* fs.remove(h.saved).pipe(Effect.ignore);
    }
    yield* removeEmpty(held);
    return lines;
  }).pipe(Effect.mapError((e) => `putting back this machine's edits: ${e.message}`));

/** The sync's directory of copies, removed when nothing in it is left. */
const removeEmpty = (held: ReadonlyArray<Held>) =>
  Effect.gen(function* () {
    if (held.length === 0) return;
    const home = process.env["HOME"] ?? "";
    const first = held[0]?.saved ?? "";
    const run = first.slice(0, first.indexOf("/", approvedDir(home).length + 1));
    const left = yield* exec({
      command: "find",
      args: [run, "-type", "f"],
      timeout: Duration.seconds(10),
    });
    if (left.stdout.trim() === "")
      yield* exec({ command: "rm", args: ["-rf", run], timeout: Duration.seconds(10) });
  });

/** What gets past a pull refused for an edit that does not merge: works as written. */
export const unmergedStep = (repo: string, files: ReadonlyArray<string>) =>
  `this machine's edit to ${files.join(", ")} does not merge with the branch's change. To keep both: \`git -C ${repo} -c user.name=t3-fleet -c user.email=t3-fleet@localhost stash push -m t3-fleet -- ${files.join(" ")}\`, then \`t3-fleet sync\`, then make the edit again (\`t3-fleet setup\` proposes what setup added again); \`git -C ${repo} stash show -p\` shows what it was.`;
