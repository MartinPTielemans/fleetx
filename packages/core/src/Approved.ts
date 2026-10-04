/**
 * On the proposing node: once an authority has approved its proposal, the
 * branch has those files, merged with whatever else reached it meanwhile.
 * The node's own copies are then out of date, and pulling would refuse to
 * overwrite them. They are set aside in `git stash` (recoverable), so the
 * pull brings the branch's versions; a copy identical to the branch's is left
 * for the pull to drop, as before.
 *
 * Every machine that joins with setup edits t3-fleet.toml, so two joining
 * machines approved one after the other always meet this.
 */
import * as Effect from "effect/Effect";

import { changedFiles, git, literal, ok, out } from "./Git.ts";
import { underSyncLock } from "./SyncLock.ts";

/** The files approvals of `node`'s proposals on origin/<branch> name (the approve commit lists them). */
export const approvedFiles = (log: string, node: string) => {
  const files = new Set<string>();
  for (const entry of log.split("\u001e")) {
    const [subject = "", ...body] = entry.trim().split("\n");
    if (!subject.startsWith(`Approve ${node}'s proposal`)) continue;
    for (const line of body) if (line.trim() !== "") files.add(line.trim());
  }
  return [...files];
};

export const settleApproval = (repo: string, node: string, branch: string) =>
  underSyncLock(
    Effect.gen(function* () {
      if (!ok(yield* git(repo, ["fetch", "-q", "origin", branch]))) return [] as Array<string>;
      const log = yield* git(repo, ["log", "--format=%s%n%b%x1e", `HEAD..origin/${branch}`]);
      const files = approvedFiles(log.stdout, node);
      if (files.length === 0) return [];
      const edited = yield* changedFiles(repo, files);
      const setAside: Array<string> = [];
      for (const file of edited) {
        const local = out(yield* git(repo, ["hash-object", "--", file], { env: literal }));
        const theirs = out(yield* git(repo, ["rev-parse", `origin/${branch}:${file}`]));
        if (local !== "" && local === theirs) continue;
        yield* git(
          repo,
          [
            "stash",
            "push",
            "-q",
            "--include-untracked",
            "-m",
            `T3 Fleet: approved ${file}; the branch has it now`,
            "--",
            file,
          ],
          { env: literal },
        );
        setAside.push(file);
      }
      return setAside;
    }),
  );
