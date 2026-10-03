/**
 * Proposals: changes a non-authority node made under the auto-commit paths,
 * waiting on fleetx/staging/<node> for an authority.
 *
 *   approve  the proposal's files land on the branch (one commit), and the
 *            staging branch is deleted
 *   reject   the proposal moves to fleetx/rejected/<node>; on its next sync
 *            the proposing node stashes its local copies and deletes it
 *
 * `[fleet] auto_approve = ["skills/"]` approves proposals whose files are all
 * under those prefixes during the authority's own sync.
 */
import * as Effect from "effect/Effect";

import { git, ok, out, why } from "./Git.ts";

export const STAGING = "fleetx/staging/";
export const REJECTED = "fleetx/rejected/";

export interface Proposal {
  readonly node: string;
  readonly commit: string;
  readonly files: ReadonlyArray<string>;
  readonly stat: string;
}

/** Every pending proposal, fetched from the remote. */
export const listProposals = (repo: string, branch: string) =>
  Effect.gen(function* () {
    yield* git(repo, ["fetch", "-q", "--prune", "origin", `+refs/heads/${STAGING}*:refs/remotes/origin/${STAGING}*`, branch]);
    const refs = out(yield* git(repo, ["for-each-ref", "--format=%(refname:strip=3)", `refs/remotes/origin/${STAGING}`]))
      .split("\n")
      .filter(Boolean);
    const proposals: Array<Proposal> = [];
    for (const ref of refs) {
      const node = ref.slice(STAGING.length);
      const commit = out(yield* git(repo, ["rev-parse", `origin/${ref}`]));
      const files = out(yield* git(repo, ["diff", "--name-only", `origin/${branch}`, commit])).split("\n").filter(Boolean);
      if (files.length === 0) continue;
      const stat = out(yield* git(repo, ["diff", "--stat", `origin/${branch}`, commit]));
      proposals.push({ node, commit, files, stat });
    }
    return proposals;
  });

/**
 * Apply a proposal on the branch: check out its files from the proposal
 * commit (additions and edits) and drop the ones it deleted, commit, push.
 */
export const approve = (repo: string, branch: string, proposal: Proposal, by: string) =>
  Effect.gen(function* () {
    const status = out(yield* git(repo, ["status", "--porcelain", "--", ...proposal.files]));
    if (status !== "") return yield* Effect.fail(`local edits to ${proposal.files.join(", ")} would be overwritten; commit or stash them first`);
    const pull = yield* git(repo, ["pull", "-q", "--rebase", "--autostash", "origin", branch]);
    if (!ok(pull)) return yield* Effect.fail(`pull failed: ${why(pull)}`);
    const present = out(yield* git(repo, ["ls-tree", "-r", "--name-only", proposal.commit, "--", ...proposal.files])).split("\n").filter(Boolean);
    const removed = proposal.files.filter((f) => !present.includes(f));
    if (present.length > 0) {
      const checkout = yield* git(repo, ["checkout", proposal.commit, "--", ...present]);
      if (!ok(checkout)) return yield* Effect.fail(`applying: ${why(checkout)}`);
    }
    if (removed.length > 0) yield* git(repo, ["rm", "-q", "--ignore-unmatch", "--", ...removed]);
    const commit = yield* git(repo, ["commit", "-q", "-m", `Approve ${proposal.node}'s proposal (by ${by})\n\n${proposal.files.join("\n")}`, "--", ...proposal.files]);
    if (!ok(commit)) return yield* Effect.fail(`commit failed: ${why(commit)}`);
    const push = yield* git(repo, ["push", "-q", "origin", `HEAD:${branch}`]);
    if (!ok(push)) return yield* Effect.fail(`push failed: ${why(push)}`);
    yield* git(repo, ["push", "-q", "origin", `:refs/heads/${STAGING}${proposal.node}`]);
    return out(yield* git(repo, ["rev-parse", "--short", "HEAD"]));
  });

export const reject = (repo: string, proposal: Proposal) =>
  Effect.gen(function* () {
    const push = yield* git(repo, ["push", "-q", "--force", "origin", `${proposal.commit}:refs/heads/${REJECTED}${proposal.node}`, `:refs/heads/${STAGING}${proposal.node}`]);
    if (!ok(push)) return yield* Effect.fail(`reject failed: ${why(push)}`);
  });

/** Under one of the auto-approve prefixes, every file. */
export const autoApprovable = (proposal: Proposal, prefixes: ReadonlyArray<string>) =>
  prefixes.length > 0 && proposal.files.every((f) => prefixes.some((p) => f.startsWith(p)));

/**
 * On the proposing node: if its proposal was rejected, set its local copies
 * of those files aside (in `git stash`, recoverable) and restore the
 * branch's versions.
 */
export const settleRejection = (repo: string, node: string, branch: string) =>
  Effect.gen(function* () {
    const ref = `refs/heads/${REJECTED}${node}`;
    const remote = yield* git(repo, ["ls-remote", "origin", ref]);
    const commit = out(remote).split(/\s+/)[0] ?? "";
    if (commit === "") return [] as Array<string>;
    yield* git(repo, ["fetch", "-q", "origin", ref]);
    const files = out(yield* git(repo, ["diff", "--name-only", `origin/${branch}`, commit])).split("\n").filter(Boolean);
    for (const file of files) {
      const tracked = ok(yield* git(repo, ["cat-file", "-e", `origin/${branch}:${file}`]));
      yield* git(repo, ["stash", "push", "-q", "--include-untracked", "-m", `fleetx: rejected ${file}`, "--", file]);
      if (!tracked) continue;
      yield* git(repo, ["checkout", `origin/${branch}`, "--", file]);
    }
    yield* git(repo, ["push", "-q", "origin", `:${ref}`]);
    return files;
  });
