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

import { sh } from "./Area.ts";
import { exec } from "./Exec.ts";
import { changedFiles, entryAt, entryHere, git, literal, nulList, ok, out, sameAt } from "./Git.ts";
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

/**
 * This node's last proposal: whether an approval naming it is among the
 * incoming commits, and the files it changed. The proposal an approval names
 * is in the approval's real trailer block, never a line elsewhere in its message.
 */
const proposalState = (repo: string, node: string, branch: string, proposal: string | null) =>
  Effect.gen(function* () {
    if (proposal === null) return { approved: false, proposed: new Set<string>() };
    const log = (yield* git(repo, [
      "log",
      "--format=%s%x00%(trailers:key=Proposal,valueonly)%x1e",
      `HEAD..origin/${branch}`,
    ])).stdout;
    const approved = log
      .split("\u001e")
      .map((entry) => entry.replace(/^\n/, "").split("\u0000"))
      .some(
        ([subject = "", trailers = ""]) =>
          subject.startsWith(`Approve ${node}'s proposal`) &&
          trailers.split("\n").some((v) => v.trim() === proposal),
      );
    const proposed = new Set(
      nulList(
        (yield* git(repo, ["diff", "--name-only", "-z", "--no-renames", `${proposal}^`, proposal]))
          .stdout,
      ),
    );
    return { approved, proposed };
  });

/**
 * Of `files`, those exactly as this node's approved proposal had them (content
 * and mode), against origin/<branch> as fetched: what the pull may replace.
 * Sync leaves them out of a held-back unit it sets aside, so bringing the
 * unit back never meets a file the pull brought.
 */
export const approvedCopies = (
  repo: string,
  node: string,
  branch: string,
  files: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const proposal = yield* lastProposal(repo);
    const { approved, proposed } = yield* proposalState(repo, node, branch, proposal);
    const copies = new Set<string>();
    if (!approved || proposal === null) return copies;
    for (const file of files)
      if (proposed.has(file) && (yield* sameAt(repo, proposal, file))) copies.add(file);
    return copies;
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
  /** Why dropping failed part-way, when it did: everything was put back first. */
  readonly failure: string | null;
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
      const empty: Settled = { proposal, dropped: [], overlapping: [], pending: [], failure: null };
      if (changed.length === 0) return empty;

      const { approved, proposed } = yield* proposalState(repo, node, branch, proposal);

      const dropped: Array<string> = [];
      const overlapping: Array<string> = [];
      const pending: Array<string> = [];
      // The branch's change, and this node's proposal: a file approved and then removed again
      // (proposed secrets, once merged) is in the proposal though the branch's diff nets out.
      for (const file of changed.filter((f) => incoming.has(f) || proposed.has(f))) {
        // What arrives as it is here: the pull handles it (Git.pullBranch).
        if (incoming.has(file) && (yield* sameAt(repo, `origin/${branch}`, file))) continue;
        const asProposed =
          proposal !== null &&
          proposed.has(file) &&
          !exclude.has(file) &&
          (yield* sameAt(repo, proposal, file));
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
      // Not dropped after all: every file is left to the pull, which refuses, and named.
      const failure = yield* drop.pipe(
        Effect.as(null),
        Effect.catch((e: string) =>
          restoreDropped(repo, { ...empty, dropped: done }).pipe(
            Effect.as(e),
            Effect.catch((again: string) => Effect.succeed(`${e}; ${again}`)),
          ),
        ),
      );
      if (failure !== null)
        return {
          proposal,
          dropped: [],
          overlapping: [...dropped.filter((f) => incoming.has(f)), ...overlapping],
          pending,
          failure: `settling this machine's approved files: ${failure}`,
        } satisfies Settled;
      return { proposal, dropped, overlapping, pending, failure: null } satisfies Settled;
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

/**
 * What stops the recovery step itself: a file git cannot read, or a folder it
 * cannot write (putting the branch's version back writes there). A line each.
 */
export const permissionProblems = (repo: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const problems: Array<string> = [];
    const dirs = new Set<string>();
    for (const file of files) {
      if ((yield* entryHere(repo, file)) === "unreadable")
        problems.push(`${file} cannot be read: \`chmod u+r ${sh(`${repo}/${file}`)}\``);
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      const writable = yield* exec({ command: "test", args: ["-w", `${repo}/${dir}`] });
      if (writable.code !== 0)
        problems.push(`${dir}/ cannot be written: \`chmod u+w ${sh(`${repo}/${dir}`)}\``);
    }
    return problems;
  });

/** What gets past a pull refused for an edit the incoming change also touches: works as written. */
export const unmergedStep = (
  repo: string,
  files: ReadonlyArray<string>,
  problems: ReadonlyArray<string> = [],
) =>
  `${problems.length > 0 ? `First let git read and write them: ${problems.join("; ")}. Then, to` : "To"} keep this machine's edit and take the branch's change: \`git -C ${sh(repo)} -c user.name=t3-fleet -c user.email=t3-fleet@localhost stash push -u -m t3-fleet -- ${files.map(sh).join(" ")}\`, then \`t3-fleet sync\`, then make the edit again on top (\`git -C ${sh(repo)} stash show -p --include-untracked\` shows it; \`t3-fleet setup\` offers what setup added again).`;
