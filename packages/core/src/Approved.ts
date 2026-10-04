/**
 * On a proposing node, before it pulls: its own copies of files the branch
 * has changed. Every machine that joins with setup edits t3-fleet.toml, so
 * two joining machines meet this whether the first is approved or not.
 *
 *   - a copy of a file approved from this node, the same as it proposed
 *     (its last proposal commit): it is what was approved, and is dropped;
 *   - a copy edited since it was proposed, or not approved and overlapping
 *     someone else's change: merged with the branch's version now (text with
 *     git merge-file, TOML additions with TomlMerge). When that merges
 *     cleanly the copy is saved under ~/.local/state/t3-fleet/approved/<time>/,
 *     the pull brings the branch's version, and the merge is written over it,
 *     so the next sync proposes the edit again on top of the branch;
 *   - an approved file edited since that does not merge: saved there, named,
 *     and the branch's version taken;
 *   - anything else is left as it is, and the pull refuses as it always has.
 *
 * Nothing goes to the shared `git stash`.
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

/** An edit set aside before the pull: written back after it (`merged`), or only named. */
export interface Held {
  readonly file: string;
  /** The saved copy. */
  readonly saved: string;
  /** The edit on top of the branch's version; null when they do not merge. */
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

/** `ours` with what changed from `base` to `theirs`, or null when they conflict. */
const merge3 = (dir: string, file: string, base: string, ours: string, theirs: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    const [b, o, t] = [`${dir}/base`, `${dir}/ours`, `${dir}/theirs`];
    yield* fs.writeFileString(b, base);
    yield* fs.writeFileString(o, ours);
    yield* fs.writeFileString(t, theirs);
    const merged = yield* exec({
      command: "git",
      args: ["merge-file", "-p", o, b, t],
      timeout: Duration.seconds(30),
    });
    yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
    if (merged.code === 0) return merged.stdout;
    return file.endsWith(".toml") ? mergeAdditions(base, theirs, ours) : null;
  });

export const settleApproval = (repo: string, node: string, branch: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = process.env["HOME"] ?? "";
      const none = { dropped: [] as Array<string>, held: [] as Array<Held> };
      if (!ok(yield* git(repo, ["fetch", "-q", "origin", branch]))) return none;
      const log = yield* git(repo, ["log", "--format=%s%n%b%x1e", `HEAD..origin/${branch}`]);
      const approved = approvedFiles(log.stdout, node);
      const incoming = nulList(
        (yield* git(repo, ["diff", "--name-only", "-z", "--no-renames", `HEAD...origin/${branch}`]))
          .stdout,
      );
      const files = [...new Set([...approved, ...incoming])];
      if (files.length === 0) return none;
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
      const saveDir = `${stateDir(home)}/approved/${yield* Clock.currentTimeMillis}`;
      const dropped: Array<string> = [];
      const held: Array<Held> = [];
      for (const file of yield* changedFiles(repo, files)) {
        const exists = yield* fs.exists(`${repo}/${file}`).pipe(Effect.orElseSucceed(() => false));
        const local = exists
          ? out(yield* git(repo, ["hash-object", "--", file], { env: literal }))
          : "";
        if (local !== "" && local === (yield* blob(`origin/${branch}`, file))) continue;
        const wasApproved = approved.includes(file);
        if (wasApproved && proposal !== null && local === (yield* blob(proposal, file))) {
          yield* dropLocal(repo, file);
          dropped.push(file);
          continue;
        }
        const baseRev = wasApproved && proposal !== null ? proposal : "HEAD";
        const [base, theirs] = [yield* show(baseRev, file), yield* show(`origin/${branch}`, file)];
        const ours = exists ? yield* fs.readFileString(`${repo}/${file}`) : null;
        const merged =
          base !== null && theirs !== null && ours !== null
            ? yield* merge3(`${saveDir}/.merge`, file, base, ours, theirs)
            : null;
        // Not approved and not mergeable: left for the pull to refuse, as it always has.
        if (merged === null && !wasApproved) continue;
        if (exists) {
          const saved = `${saveDir}/${file}`;
          yield* fs.makeDirectory(saved.slice(0, saved.lastIndexOf("/")), { recursive: true });
          yield* fs.copyFile(`${repo}/${file}`, saved);
          held.push({ file, saved, merged });
        }
        yield* dropLocal(repo, file);
      }
      return { dropped, held };
    }).pipe(Effect.mapError((e) => `setting aside this machine's edits: ${e.message}`)),
  );

/** After the pull: each edit written back on top of the branch's version, or named where it is kept. */
export const reapplyHeld = (repo: string, held: ReadonlyArray<Held>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines: Array<string> = [];
    for (const h of held) {
      if (h.merged !== null) {
        yield* fs.writeFileString(`${repo}/${h.file}`, h.merged);
        lines.push(`kept this machine's edit to ${h.file}, on top of the branch's version`);
      } else
        lines.push(
          `this machine's edit to ${h.file} does not fit the approved version; the branch's stays, the edit is in ${h.saved}`,
        );
    }
    return lines;
  }).pipe(Effect.mapError((e) => `putting back this machine's edits: ${e.message}`));
