/**
 * On a proposing node, just before it pulls: the one case where sync touches
 * the member's own copies. Two machines joining at once both edit
 * t3-fleet.toml; an authority approves each, merging them (TomlMerge, in
 * approve). Each member still has its copy as it proposed it, which overlaps
 * the approved, merged version, so its pull would be refused forever.
 *
 * So a copy that is byte for byte, mode included, what this node's last
 * proposal has, when that proposal's approval is among the incoming commits,
 * is dropped, and the pull brings the branch's version. If the pull fails,
 * each dropped file comes back from the proposal commit, exactly. The
 * proposal is kept reachable by a ref (PROPOSAL_REF), so git, not a copy
 * somewhere, is what restores it.
 *
 * Nothing else is touched: an edit made after the proposal, a file the
 * proposal did not contain, what sync holds back for a secret, and every
 * file of a member with commits of its own. Those overlap the incoming
 * change, the pull refuses as it always has, and sync names each file with
 * the step that gets past it (unmergedStep).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { changedFiles, git, literal, nulList, ok, out } from "./Git.ts";
import { stateDir } from "./Names.ts";
import { underSyncLock } from "./SyncLock.ts";

/** Where this node records its last proposal's commit (Sync.ts writes it). */
export const lastProposalPath = (home: string) => `${stateDir(home)}/last-proposal`;

/** Keeps the last proposal's commit reachable here, whatever git gc does. */
export const PROPOSAL_REF = "refs/t3-fleet/last-proposal";

/** The line an approval adds, naming the proposal commit it approved (Staging.approve). */
export const proposalTrailer = (commit: string) => `Proposal: ${commit}`;

/** This node's proposal, recorded by its last sync, when this checkout still has it. */
const lastProposal = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    const recorded = Option.getOrNull(
      yield* fs.readFileString(lastProposalPath(home)).pipe(
        Effect.map((t) => t.trim()),
        Effect.option,
      ),
    );
    if (recorded === null || recorded === "") return null;
    const commit = yield* git(repo, ["rev-parse", "-q", "--verify", `${recorded}^{commit}`]);
    return ok(commit) ? out(commit) : null;
  });

/** A file's blob and mode in a commit; null when the commit lacks it. */
const entryAt = (repo: string, rev: string, file: string) =>
  git(repo, ["ls-tree", "-z", rev, "--", file], { env: literal }).pipe(
    Effect.map((r) => {
      const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(r.stdout);
      return m === null ? null : { mode: m[1] ?? "", blob: m[2] ?? "" };
    }),
  );

/** Whether the file here is exactly the commit's: content and executable bit, or absent from both. */
const sameAs = (repo: string, rev: string, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const there = yield* entryAt(repo, rev, file);
    const info = yield* fs.stat(`${repo}/${file}`).pipe(Effect.option);
    if (Option.isNone(info)) return there === null;
    if (there === null || info.value.type !== "File") return false;
    const blob = out(yield* git(repo, ["hash-object", "--", file], { env: literal }));
    const executable = (Number(info.value.mode) & 0o111) !== 0;
    return blob === there.blob && executable === (there.mode === "100755");
  });

export interface Settled {
  /** The proposal commit the dropped files come back from, if the pull fails. */
  readonly proposal: string | null;
  /** Put back to HEAD for the pull: exactly what the approved proposal had. */
  readonly dropped: ReadonlyArray<string>;
  /** Edits the incoming change also touches, left in place: the pull refuses them. */
  readonly overlapping: ReadonlyArray<string>;
  /** Of those, the ones exactly as this node proposed them, waiting for an approval. */
  readonly pending: ReadonlyArray<string>;
}

/**
 * Before the pull, against origin/<branch> as already fetched. `exclude`:
 * files sync holds back for a secret. `how`: a member with commits of its
 * own rebases, and then nothing is dropped.
 */
export const settleApproval = (
  repo: string,
  node: string,
  branch: string,
  options: { readonly exclude?: ReadonlySet<string>; readonly how: "rebase" | "ff-only" },
) =>
  underSyncLock(
    Effect.gen(function* () {
      const exclude = options.exclude ?? new Set<string>();
      const incoming = new Set(
        nulList(
          (yield* git(repo, [
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            `HEAD...origin/${branch}`,
          ])).stdout,
        ),
      );
      const changed = yield* changedFiles(repo);
      const proposal = yield* lastProposal(repo);
      const empty: Settled = { proposal, dropped: [], overlapping: [], pending: [] };
      if (changed.length === 0) return empty;

      const log = (yield* git(repo, ["log", "--format=%B%x1e", `HEAD..origin/${branch}`])).stdout;
      const approved =
        proposal !== null &&
        log
          .split("\u001e")
          .map((entry) => entry.trim())
          .some(
            (entry) =>
              entry.startsWith(`Approve ${node}'s proposal`) &&
              entry.split("\n").includes(proposalTrailer(proposal)),
          );
      const proposed =
        proposal === null
          ? new Set<string>()
          : new Set(
              nulList(
                (yield* git(repo, [
                  "diff",
                  "--name-only",
                  "-z",
                  "--no-renames",
                  `${proposal}^`,
                  proposal,
                ])).stdout,
              ),
            );

      const dropped: Array<string> = [];
      const overlapping: Array<string> = [];
      const pending: Array<string> = [];
      // The branch's change, and this node's proposal: a file approved and then removed again
      // (proposed secrets, once merged) is in the proposal though the branch's diff nets out.
      for (const file of changed.filter((f) => incoming.has(f) || proposed.has(f))) {
        // What arrives as it is here: the pull handles it (Git.pullBranch).
        if (incoming.has(file) && (yield* sameAs(repo, `origin/${branch}`, file))) continue;
        const asProposed =
          proposal !== null &&
          proposed.has(file) &&
          !exclude.has(file) &&
          (yield* sameAs(repo, proposal, file));
        if (asProposed && approved && options.how === "ff-only") {
          dropped.push(file);
          continue;
        }
        if (!incoming.has(file)) continue;
        overlapping.push(file);
        if (asProposed && !approved) pending.push(file);
      }
      // Decided above with nothing changed; a failure part-way puts back what was dropped so far.
      const done: Array<string> = [];
      const drop = Effect.forEach(dropped, (file) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (ok(yield* git(repo, ["cat-file", "-e", `HEAD:${file}`]))) {
            const reset = yield* git(repo, ["checkout", "-q", "HEAD", "--", file], {
              env: literal,
            });
            if (!ok(reset))
              return yield* Effect.fail(`git checkout ${file}: ${reset.stderr.trim()}`);
          } else
            yield* fs
              .remove(`${repo}/${file}`, { force: true })
              .pipe(Effect.mapError((e) => e.message));
          done.push(file);
        }),
      );
      yield* drop.pipe(
        Effect.catch((e: string) =>
          restoreDropped(repo, { proposal, dropped: done, overlapping, pending }).pipe(
            Effect.andThen(Effect.fail(e)),
          ),
        ),
      );
      return { proposal, dropped, overlapping, pending } satisfies Settled;
    }).pipe(Effect.mapError((e) => `settling this machine's approved files: ${e}`)),
  );

/** The pull failed: each dropped file back exactly as the proposal had it, the index as it was. */
export const restoreDropped = (repo: string, settled: Settled) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (settled.proposal === null || settled.dropped.length === 0) return;
    for (const file of settled.dropped) {
      if ((yield* entryAt(repo, settled.proposal, file)) === null) {
        yield* fs.remove(`${repo}/${file}`, { force: true });
        continue;
      }
      const back = yield* git(repo, ["checkout", "-q", settled.proposal, "--", file], {
        env: literal,
      });
      if (!ok(back)) return yield* Effect.fail(`git checkout ${file}: ${back.stderr.trim()}`);
      yield* git(repo, ["reset", "-q", "--", file], { env: literal });
    }
  }).pipe(
    Effect.mapError(
      (e) =>
        `putting back this machine's approved files from ${settled.proposal ?? "its proposal"}: ${typeof e === "string" ? e : e.message}`,
    ),
  );

/** What gets past a pull refused for an edit the incoming change also touches: works as written. */
export const unmergedStep = (repo: string, files: ReadonlyArray<string>) =>
  `To keep this machine's edit and take the branch's change: \`git -C ${repo} -c user.name=t3-fleet -c user.email=t3-fleet@localhost stash push -m t3-fleet -- ${files.join(" ")}\`, then \`t3-fleet sync\`, then make the edit again on top (\`git -C ${repo} stash show -p\` shows it; \`t3-fleet setup\` offers what setup added again).`;
