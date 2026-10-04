/**
 * Proposals: changes a non-authority node made under the auto-commit paths,
 * waiting on t3-fleet/staging/<node> for an authority.
 *
 *   approve  the proposal's change lands on the branch (one commit), merged
 *            with whatever reached it since, and the staging branch is
 *            deleted
 *   reject   the proposal moves to t3-fleet/rejected/<node>; on its next sync
 *            the proposing node stashes its edits to those files and deletes it
 *
 * `[fleet] auto_approve = ["skills/"]` approves proposals whose files are all
 * under those prefixes during the authority's own sync.
 *
 * Until 1.0 the fleetx/staging and fleetx/rejected branches are read too
 * (Names.ts): a repo not renamed yet uses them, and so does a machine that has
 * not pulled the rename.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { changedFiles, git, literal, nulList, ok, out, pullBranch, why } from "./Git.ts";
import { branchPrefix, branchPrefixes, stateDir } from "./Names.ts";
import { underSyncLock } from "./SyncLock.ts";

export interface Proposal {
  readonly node: string;
  /** The branch it waits on: t3-fleet/staging/<node>, or fleetx/staging/<node>. */
  readonly branch: string;
  readonly commit: string;
  /** What the proposal's own commit changes. */
  readonly files: ReadonlyArray<string>;
  readonly stat: string;
}

/** The files `commit` itself changes, against its parent: the proposal, whatever the branch did since. */
const ownChange = (repo: string, commit: string) =>
  git(repo, ["diff", "--name-only", "-z", "--no-renames", `${commit}^`, commit]).pipe(Effect.map((r) => nulList(r.stdout)));

/** Every pending proposal, fetched from the remote. */
export const listProposals = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const prefixes = branchPrefixes("staging");
    yield* git(repo, ["fetch", "-q", "--prune", "origin", ...prefixes.map((p) => `+refs/heads/${p}*:refs/remotes/origin/${p}*`), branch]);
    const refs = out(yield* git(repo, ["for-each-ref", "--format=%(refname:strip=3)", ...prefixes.map((p) => `refs/remotes/origin/${p}`)]))
      .split("\n")
      .filter(Boolean);
    const proposals: Array<Proposal> = [];
    for (const ref of refs) {
      const node = ref.slice((prefixes.find((p) => ref.startsWith(p)) ?? "").length);
      const commit = out(yield* git(repo, ["rev-parse", `origin/${ref}`]));
      const files = yield* ownChange(repo, commit);
      if (files.length === 0) continue;
      // Already on the branch (approved, its staging branch not yet gone): nothing to review.
      if (ok(yield* git(repo, ["diff", "--quiet", `origin/${branch}`, commit, "--", ...files], { env: literal }))) continue;
      const stat = out(yield* git(repo, ["diff", "--stat", `${commit}^`, commit]));
      proposals.push({ node, branch: ref, commit, files, stat });
    }
    return proposals;
  });

/** Where the proposal's staging branch points now on the remote, or "" when it is gone. */
const tipOf = (repo: string, proposal: Proposal) =>
  git(repo, ["ls-remote", "origin", `refs/heads/${proposal.branch}`]).pipe(Effect.map((r) => out(r).split(/\s+/)[0] ?? ""));

/** The patch id of `commit`'s own change: equal for the same change made again on another base. */
const patchId = (repo: string, commit: string) =>
  Effect.gen(function* () {
    const diff = yield* git(repo, ["diff-tree", "-p", "--no-renames", `${commit}^`, commit]);
    if (!ok(diff) || diff.stdout === "") return "";
    return out(yield* git(repo, ["patch-id", "--stable"], { stdin: diff.stdout })).split(/\s+/)[0] ?? "";
  });

/**
 * The proposal's tip, fetched, when it is still the change that was reviewed:
 * the same commit, or the same change remade on a newer branch.
 */
const reviewedTip = (repo: string, proposal: Proposal, expected: string | undefined) =>
  Effect.gen(function* () {
    const reviewed = expected ?? proposal.commit;
    const tip = yield* tipOf(repo, proposal);
    if (tip === "") return yield* Effect.fail(`${proposal.node}'s proposal is gone: approved, rejected or withdrawn since`);
    const fetch = yield* git(repo, ["fetch", "-q", "origin", `refs/heads/${proposal.branch}`]);
    if (!ok(fetch)) return yield* Effect.fail(`fetching the proposal: ${why(fetch)}`);
    if (reviewed.length >= 7 && tip.startsWith(reviewed)) return tip;
    const known = out(yield* git(repo, ["rev-parse", "-q", "--verify", `${reviewed}^{commit}`]));
    const same = reviewed.length >= 7 && known !== "" && (yield* patchId(repo, known)) !== "" && (yield* patchId(repo, known)) === (yield* patchId(repo, tip));
    if (!same) return yield* Effect.fail(`${proposal.node}'s proposal is ${tip.slice(0, 7)} now, not the ${reviewed.slice(0, 7)} reviewed; review it again`);
    return tip;
  });

/** Delete the staging branch, unless its node proposed something else meanwhile. */
const dropStaging = (repo: string, proposal: Proposal, tip: string) =>
  git(repo, ["push", "-q", `--force-with-lease=refs/heads/${proposal.branch}:${tip}`, "origin", `:refs/heads/${proposal.branch}`]);

/**
 * Apply a proposal on the branch: its own commit's change, merged three ways
 * onto what the branch has now (cherry-pick), so whatever reached the branch
 * after the proposal was made stays. The merge happens in a scratch worktree,
 * so a conflict never leaves a mark in the checkout; the checkout only
 * fast-forwards to the result. Refuses on a conflict, and when the proposal
 * is no longer `expected`, the change the caller reviewed.
 */
export const approve = (repo: string, branch: string, proposal: Proposal, by: string, expected?: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const tip = yield* reviewedTip(repo, proposal, expected);
      const files = yield* ownChange(repo, tip);
      const dirty = yield* changedFiles(repo, files);
      if (dirty.length > 0) return yield* Effect.fail(`local edits to ${dirty.join(", ")} would be overwritten; commit or stash them first`);
      yield* pullBranch(repo, branch, "rebase").pipe(Effect.mapError((e) => `pull failed: ${e}`));
      const approved = yield* inScratchWorktree(
        repo,
        Effect.fnUntraced(function* (scratch: string) {
          const pick = yield* git(scratch, ["cherry-pick", "--no-commit", tip]);
          if (!ok(pick)) {
            const conflicted = nulList((yield* git(scratch, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout);
            return yield* Effect.fail(
              `${proposal.node}'s proposal conflicts with what reached ${branch} since it was made${conflicted.length > 0 ? ` (${conflicted.join(", ")})` : ""}; reject it, or have ${proposal.node} sync and propose again`,
            );
          }
          // Already on the branch: nothing to commit.
          if (ok(yield* git(scratch, ["diff", "--cached", "--quiet", "HEAD"]))) return null;
          const commit = yield* git(scratch, ["commit", "-q", "-m", `Approve ${proposal.node}'s proposal (by ${by})\n\n${files.join("\n")}`]);
          if (!ok(commit)) return yield* Effect.fail(`commit failed: ${why(commit)}`);
          return out(yield* git(scratch, ["rev-parse", "HEAD"]));
        }),
      );
      if (approved !== null) {
        const forward = yield* git(repo, ["merge", "-q", "--ff-only", approved]);
        if (!ok(forward)) return yield* Effect.fail(`could not move the checkout to the approved commit: ${why(forward)}`);
        const push = yield* git(repo, ["push", "-q", "origin", `HEAD:${branch}`]);
        if (!ok(push)) return yield* Effect.fail(`push failed: ${why(push)}`);
      }
      yield* dropStaging(repo, proposal, tip);
      return out(yield* git(repo, ["rev-parse", "--short", "HEAD"]));
    }),
  );

/** Run `use` in a throwaway worktree of `repo` at its HEAD, removed afterwards whatever happens. */
const inScratchWorktree = <A, E, R>(repo: string, use: (scratch: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratch = `${stateDir(process.env["HOME"] ?? "")}/approve`;
    const remove = Effect.gen(function* () {
      yield* git(repo, ["worktree", "remove", "--force", scratch]);
      yield* fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore);
      yield* git(repo, ["worktree", "prune"]);
    });
    // One left behind by a run that died.
    yield* remove;
    yield* fs.makeDirectory(stateDir(process.env["HOME"] ?? ""), { recursive: true }).pipe(Effect.ignore);
    const add = yield* git(repo, ["worktree", "add", "-q", "--detach", scratch, "HEAD"]);
    if (!ok(add)) return yield* Effect.fail(`making a scratch worktree: ${why(add)}`);
    return yield* use(scratch).pipe(Effect.ensuring(remove));
  });

/** Move the proposal to t3-fleet/rejected/<node>, if it is still `expected` (the commit reviewed). */
export const reject = (repo: string, proposal: Proposal, expected?: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const tip = yield* reviewedTip(repo, proposal, expected);
      const push = yield* git(repo, [
        "push",
        "-q",
        `--force-with-lease=refs/heads/${proposal.branch}:${tip}`,
        "origin",
        `+${tip}:refs/heads/${branchPrefix(repo, "rejected")}${proposal.node}`,
        `:refs/heads/${proposal.branch}`,
      ]);
      if (!ok(push)) return yield* Effect.fail(`reject failed: ${why(push)}`);
    }),
  );

/** Under one of the auto-approve prefixes, every file. */
export const autoApprovable = (proposal: Proposal, prefixes: ReadonlyArray<string>) =>
  prefixes.length > 0 && proposal.files.every((f) => prefixes.some((p) => f.startsWith(p)));

/**
 * On the proposing node: if its proposal was rejected, set aside its local
 * edits to the files that proposal changed (in `git stash`, recoverable),
 * which leaves the checkout's versions; the next pull brings the branch's.
 * Edits to any other file are not touched. The files set aside.
 */
export const settleRejection = (repo: string, node: string, branch: string) =>
  underSyncLock(
    Effect.gen(function* () {
      let ref = "";
      let commit = "";
      for (const prefix of branchPrefixes("rejected")) {
        ref = `refs/heads/${prefix}${node}`;
        commit = out(yield* git(repo, ["ls-remote", "origin", ref])).split(/\s+/)[0] ?? "";
        if (commit !== "") break;
      }
      if (commit === "") return [] as Array<string>;
      yield* git(repo, ["fetch", "-q", "origin", ref, branch]);
      const edited = yield* changedFiles(repo, yield* ownChange(repo, commit));
      for (const file of edited) {
        yield* git(repo, ["stash", "push", "-q", "--include-untracked", "-m", `T3 Fleet: rejected ${file}`, "--", file], { env: literal });
      }
      yield* git(repo, ["push", "-q", "origin", `:${ref}`]);
      return edited;
    }),
  );
