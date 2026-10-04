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
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  changedFiles,
  git,
  literal,
  nulList,
  ok,
  out,
  pathLine,
  pullBranch,
  scanEdits,
  scanStaged,
  unmergedHits,
  unsafePath,
  why,
} from "./Git.ts";
import { proposalTrailer } from "./Approved.ts";
import { heldBack, setAsideUnits, SOURCES, unitOf } from "./Held.ts";
import { readAllowed, refusal } from "./SecretScan.ts";
import { sourcesEntriesChanged } from "./SkillSources.ts";
import { isDeparture, removeNode } from "./leave/Fleet.ts";
import { branchPrefix, stateDir } from "./Names.ts";
import { mergeProposedSecrets } from "./ProposedSecrets.ts";
import { PROPOSED_SECRETS } from "./setup/Plan.ts";
import { mergeAdditions } from "./setup/TomlMerge.ts";
import { underSyncLock } from "./SyncLock.ts";

export interface Proposal {
  readonly node: string;
  /** The branch it waits on: t3-fleet/staging/<node>. */
  readonly branch: string;
  readonly commit: string;
  /** What the proposal's own commit changes. */
  readonly files: ReadonlyArray<string>;
  readonly stat: string;
}

/** The files `commit` itself changes, against its parent: the proposal, whatever the branch did since. */
const ownChange = (repo: string, commit: string) =>
  git(repo, ["diff", "--name-only", "-z", "--no-renames", `${commit}^`, commit]).pipe(
    Effect.map((r) => nulList(r.stdout)),
  );

/** Every pending proposal, fetched from the remote. */
export const listProposals = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const prefix = branchPrefix("staging");
    yield* git(repo, [
      "fetch",
      "-q",
      "--prune",
      "origin",
      `+refs/heads/${prefix}*:refs/remotes/origin/${prefix}*`,
      branch,
    ]);
    const refs = out(
      yield* git(repo, [
        "for-each-ref",
        "--format=%(refname:strip=3)",
        `refs/remotes/origin/${prefix}`,
      ]),
    )
      .split("\n")
      .filter(Boolean);
    const proposals: Array<Proposal> = [];
    for (const ref of refs) {
      const node = ref.slice(prefix.length);
      const commit = out(yield* git(repo, ["rev-parse", `origin/${ref}`]));
      const files = yield* ownChange(repo, commit);
      if (files.length === 0) continue;
      // Already on the branch (approved, its staging branch not yet gone): nothing to review.
      if (
        ok(
          yield* git(repo, ["diff", "--quiet", `origin/${branch}`, commit, "--", ...files], {
            env: literal,
          }),
        )
      )
        continue;
      const stat = out(yield* git(repo, ["diff", "--stat", `${commit}^`, commit]));
      proposals.push({ node, branch: ref, commit, files, stat });
    }
    return proposals;
  });

/** Where the proposal's staging branch points now on the remote, or "" when it is gone. */
const tipOf = (repo: string, proposal: Proposal) =>
  git(repo, ["ls-remote", "origin", `refs/heads/${proposal.branch}`]).pipe(
    Effect.map((r) => out(r).split(/\s+/)[0] ?? ""),
  );

/**
 * `commit`'s own change, exactly: each file's mode and blob before and after.
 * Equal for the same change made again on another base, and for nothing else;
 * a patch id would also match one that only re-indents.
 */
const changeOf = (repo: string, commit: string) =>
  Effect.gen(function* () {
    const raw = yield* git(repo, [
      "diff-tree",
      "-r",
      "-z",
      "--no-renames",
      "--full-index",
      `${commit}^`,
      commit,
    ]);
    return ok(raw) ? raw.stdout : "";
  });

/**
 * The proposal's tip, fetched, when it is still the change that was reviewed:
 * the same commit, or the same change remade on a newer branch.
 */
const reviewedTip = (repo: string, proposal: Proposal, expected: string | undefined) =>
  Effect.gen(function* () {
    const reviewed = expected ?? proposal.commit;
    const tip = yield* tipOf(repo, proposal);
    if (tip === "")
      return yield* Effect.fail(
        `${proposal.node}'s proposal is gone: approved, rejected or withdrawn since`,
      );
    const fetch = yield* git(repo, ["fetch", "-q", "origin", `refs/heads/${proposal.branch}`]);
    if (!ok(fetch)) return yield* Effect.fail(`fetching the proposal: ${why(fetch)}`);
    if (reviewed.length >= 7 && tip.startsWith(reviewed)) return tip;
    const known = out(yield* git(repo, ["rev-parse", "-q", "--verify", `${reviewed}^{commit}`]));
    const change = known === "" ? "" : yield* changeOf(repo, known);
    const same = reviewed.length >= 7 && change !== "" && change === (yield* changeOf(repo, tip));
    if (!same)
      return yield* Effect.fail(
        `${proposal.node}'s proposal is ${tip.slice(0, 7)} now, not the ${reviewed.slice(0, 7)} reviewed; review it again`,
      );
    return tip;
  });

/** Delete the staging branch, unless its node proposed something else meanwhile. */
const dropStaging = (repo: string, proposal: Proposal, tip: string) =>
  git(repo, [
    "push",
    "-q",
    `--force-with-lease=refs/heads/${proposal.branch}:${tip}`,
    "origin",
    `:refs/heads/${proposal.branch}`,
  ]);

/**
 * Apply a proposal on the branch: its own commit's change, merged three ways
 * onto what the branch has now (cherry-pick), so whatever reached the branch
 * after the proposal was made stays. The merge happens in a scratch worktree,
 * so a conflict never leaves a mark in the checkout; the checkout only
 * fast-forwards to the result. Refuses on a conflict, and when the proposal
 * is no longer `expected`, the change the caller reviewed.
 */
export const approve = (
  repo: string,
  branch: string,
  proposal: Proposal,
  by: string,
  expected?: string,
) =>
  underSyncLock(
    Effect.gen(function* () {
      const tip = yield* reviewedTip(repo, proposal, expected);
      // A machine leaving the fleet, by what the proposal changes: removed from this authority's own current repo and secrets.
      if (yield* isDeparture(repo, tip, proposal.node)) {
        const removed = yield* removeNode(
          repo,
          branch,
          proposal.node,
          process.env["HOME"] ?? "",
          // The same trailer as any approval names the proposal approved (Approved.ts).
          `Approve ${proposal.node}'s departure from the fleet (by ${by})\n\n${proposalTrailer(out(yield* git(repo, ["rev-parse", `${tip}^{commit}`])))}`,
        );
        yield* dropStaging(repo, proposal, tip);
        return {
          rev: removed.rev ?? out(yield* git(repo, ["rev-parse", "--short", "HEAD"])),
          notes: [...removed.notes],
        };
      }
      const files = yield* ownChange(repo, tip);
      // A newline in a path could write a line of the approval's message; no such path enters the fleet.
      const unsafe = files.filter(unsafePath);
      if (unsafe.length > 0)
        return yield* Effect.fail(
          `${proposal.node}'s proposal has a path with a newline or other control character (${unsafe.map((f) => JSON.stringify(f)).join(", ")}); reject it`,
        );
      // A proposal carries its own machine's secrets, and no one else's.
      const foreign = files.filter(
        (f) =>
          f.startsWith(`${PROPOSED_SECRETS}/`) &&
          f !== `${PROPOSED_SECRETS}/${proposal.node}.env.age`,
      );
      if (foreign.length > 0)
        return yield* Effect.fail(
          `${proposal.node}'s proposal changes ${foreign.join(", ")}, secrets that are not its own; reject it`,
        );
      const dirty = yield* changedFiles(repo, files);
      if (dirty.length > 0) {
        // Edits sync holds back never get committed: approving sets those aside in git stash.
        const edited = yield* changedFiles(repo, [...new Set([...dirty.map(unitOf), SOURCES])]);
        const entries = edited.includes(SOURCES) ? yield* sourcesEntriesChanged(repo) : [];
        const hits = [
          ...(yield* scanEdits(repo, edited, { allowed: yield* readAllowed(repo) })),
          ...(yield* unmergedHits(repo, edited)),
        ];
        const held = heldBack(edited, hits, entries);
        const heldFiles = new Set([...held.values()].flat());
        const other = dirty.filter((f) => !heldFiles.has(f));
        if (other.length > 0 || (held.has(SOURCES) && entries === null))
          return yield* Effect.fail(
            `local edits to ${(other.length > 0 ? other : [SOURCES]).join(", ")} would be overwritten; commit or stash them first`,
          );
        const inTheWay = new Map(
          [...held].filter(([, unitFiles]) => unitFiles.some((f) => dirty.includes(f))),
        );
        const aside = yield* setAsideUnits(repo, inTheWay);
        if (aside.size < inTheWay.size)
          return yield* Effect.fail(
            `could not set ${[...inTheWay.keys()].filter((u) => !aside.has(u)).join(", ")} aside in git stash`,
          );
      }
      yield* pullBranch(repo, branch, "rebase").pipe(Effect.mapError((e) => `pull failed: ${e}`));
      const allowed = yield* readAllowed(repo);
      const approved = yield* inScratchWorktree(
        repo,
        Effect.fnUntraced(function* (scratch: string) {
          const pick = yield* git(scratch, ["cherry-pick", "--no-commit", tip]);
          if (!ok(pick)) {
            const conflicted = nulList(
              (yield* git(scratch, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout,
            );
            if (conflicted.length === 0)
              return yield* Effect.fail(
                `applying ${proposal.node}'s proposal failed: ${why(pick)}`,
              );
            // Only what two machines joining at once both add (TomlMerge.ts) merges; the rest refuses.
            const unresolved = yield* mergeTomlAdditions(scratch);
            if (unresolved.length > 0)
              return yield* Effect.fail(
                `${proposal.node}'s proposal conflicts with what reached ${branch} since it was made (${unresolved.join(", ")}). Reject it (t3-fleet reject ${proposal.node}): ${proposal.node}'s next sync sets those edits aside, and \`t3-fleet setup\` there offers what setup added again, on top of ${branch}`,
              );
          }
          // Only the files the proposal names, which is what was reviewed and
          // what auto_approve trusts: a cherry-pick follows renames, so an
          // edit to a file the branch has since moved would land elsewhere.
          const changed = nulList(
            (yield* git(scratch, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"]))
              .stdout,
          );
          const elsewhere = changed.filter((f) => !files.includes(f));
          if (elsewhere.length > 0) {
            return yield* Effect.fail(
              `${proposal.node}'s proposal would change ${elsewhere.join(", ")}, which it does not name (moved on ${branch} since?); reject it, or have ${proposal.node} sync and propose again`,
            );
          }
          // Already on the branch: nothing to commit.
          if (changed.length === 0) return null;
          // Allowed by the branch's t3-fleet.toml, not one the proposal brings along.
          const secrets = yield* scanStaged(scratch, { base: "HEAD", allowed });
          if (secrets.length > 0)
            return yield* Effect.fail(
              `${proposal.node}'s proposal adds what looks like a secret; reject it.\n${refusal(secrets)}`,
            );
          const commit = yield* git(scratch, [
            "commit",
            "-q",
            "-m",
            // The trailer names the commit approved: that member drops its copies of it (Approved.ts).
            `Approve ${proposal.node}'s proposal (by ${by})\n\n${files.map(pathLine).join("\n")}\n\n${proposalTrailer(out(yield* git(repo, ["rev-parse", `${tip}^{commit}`])))}`,
          ]);
          if (!ok(commit)) return yield* Effect.fail(`commit failed: ${why(commit)}`);
          return out(yield* git(scratch, ["rev-parse", "HEAD"]));
        }),
      );
      if (approved !== null) {
        const forward = yield* git(repo, ["merge", "-q", "--ff-only", approved]);
        if (!ok(forward))
          return yield* Effect.fail(
            `could not move the checkout to the approved commit: ${why(forward)}`,
          );
        const push = yield* git(repo, ["push", "-q", "origin", `HEAD:${branch}`]);
        if (!ok(push)) return yield* Effect.fail(`push failed: ${why(push)}`);
      }
      // Secrets the proposal brought (setup on a joining machine), now that what uses them is in;
      // also when it was on the branch already, so approving again retries a merge that failed.
      const secrets = files.filter((f) => f.startsWith(`${PROPOSED_SECRETS}/`));
      const notes =
        secrets.length === 0
          ? []
          : yield* mergeProposedSecrets(repo, secrets).pipe(
              Effect.mapError(
                (e) =>
                  `approved, but merging its secrets failed (the next sync here tries again): ${typeof e === "string" ? e : e.message}`,
              ),
            );
      yield* dropStaging(repo, proposal, tip);
      return { rev: out(yield* git(repo, ["rev-parse", "--short", "HEAD"])), notes };
    }),
  );

/**
 * After a conflicted cherry-pick: each conflicted TOML file merged by
 * additions (TomlMerge.ts) and staged. The files that remain conflicted.
 */
const mergeTomlAdditions = (scratch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const conflicted = nulList(
      (yield* git(scratch, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout,
    );
    const left: Array<string> = [];
    for (const file of conflicted) {
      const stage = (n: number) =>
        git(scratch, ["show", `:${n}:${file}`]).pipe(Effect.map((r) => (ok(r) ? r.stdout : null)));
      const [base, ours, theirs] = [yield* stage(1), yield* stage(2), yield* stage(3)];
      const merged =
        file.endsWith(".toml") && base !== null && ours !== null && theirs !== null
          ? mergeAdditions(base, ours, theirs)
          : null;
      if (merged === null) {
        left.push(file);
        continue;
      }
      yield* fs.writeFileString(`${scratch}/${file}`, merged);
      yield* git(scratch, ["add", "--", file], { env: literal });
    }
    return left;
  }).pipe(Effect.mapError((e) => `merging ${e.message}`));

/** Run `use` in a throwaway worktree of `repo` at its HEAD, removed afterwards whatever happens. */
const inScratchWorktree = <A, E, R>(
  repo: string,
  use: (scratch: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratch = `${stateDir(process.env["HOME"] ?? "")}/approve`;
    const remove = Effect.gen(function* () {
      // A run that died inside `worktree add` leaves it locked, which remove and prune skip.
      yield* git(repo, ["worktree", "unlock", scratch]);
      yield* git(repo, ["worktree", "remove", "--force", "--force", scratch]);
      yield* fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore);
      yield* git(repo, ["worktree", "prune"]);
    });
    // One left behind by a run that died.
    yield* remove;
    yield* fs
      .makeDirectory(stateDir(process.env["HOME"] ?? ""), { recursive: true })
      .pipe(Effect.ignore);
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
        // Both or neither: a rejected branch without the deletion would make the node set aside a newer proposal.
        "--atomic",
        `--force-with-lease=refs/heads/${proposal.branch}:${tip}`,
        "origin",
        `+${tip}:refs/heads/${branchPrefix("rejected")}${proposal.node}`,
        `:refs/heads/${proposal.branch}`,
      ]);
      if (!ok(push)) return yield* Effect.fail(`reject failed: ${why(push)}`);
    }),
  );

/** Under one of the auto-approve prefixes, every file. */
export const autoApprovable = (proposal: Proposal, prefixes: ReadonlyArray<string>) =>
  prefixes.length > 0 &&
  proposal.files.every((f) => prefixes.some((p) => f.startsWith(p))) &&
  // A machine's departure needs a person's approve, whatever the prefixes trust.
  !(
    proposal.files.includes(`nodes/${proposal.node}.toml`) &&
    proposal.files.every(
      (f) => f === `nodes/${proposal.node}.toml` || f === "secrets/recipients.toml",
    )
  );

/**
 * On the proposing node: if its proposal was rejected, set aside its local
 * edits to the files that proposal changed (in `git stash`, recoverable),
 * which leaves the checkout's versions; the next pull brings the branch's.
 * Edits to any other file are not touched. The files set aside.
 */
export const settleRejection = (repo: string, node: string, branch: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const ref = `refs/heads/${branchPrefix("rejected")}${node}`;
      const commit = out(yield* git(repo, ["ls-remote", "origin", ref])).split(/\s+/)[0] ?? "";
      if (commit === "") return [] as Array<string>;
      yield* git(repo, ["fetch", "-q", "origin", ref, branch]);
      const edited = yield* changedFiles(repo, yield* ownChange(repo, commit));
      for (const file of edited) {
        yield* git(
          repo,
          [
            "stash",
            "push",
            "-q",
            "--include-untracked",
            "-m",
            `T3 Fleet: rejected ${file}`,
            "--",
            file,
          ],
          { env: literal },
        );
      }
      yield* git(repo, ["push", "-q", "origin", `:${ref}`]);
      return edited;
    }),
  );
