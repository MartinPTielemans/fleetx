/**
 * Taking a node out of the fleet's config repo.
 *
 *   an authority leaving   commits the removal on top of origin's branch
 *                          itself and pushes it, refusing when no other
 *                          authority would be left
 *   a member leaving       proposes it on t3-fleet/staging/<node>, for an
 *                          authority to approve explicitly
 *   approving a departure  the authority removes the node the same way, from
 *                          its own current copy of the repo and secrets
 *                          (Staging.approve), so nothing the member proposed
 *                          has to merge, and the member can be gone
 *
 * A proposal is a departure only by what it changes: from the node's own
 * staging branch, exactly the removal of its node file and of its key from
 * the recipients (isDeparture). A commit message says nothing. Departures are
 * never approved automatically, and ordinary syncs leave them alone.
 *
 * Which path a machine takes is decided from origin's branch when it runs,
 * not from what the machine remembers: a member promoted to the fleet's only
 * authority since is refused like any only authority.
 *
 * Every removal is built in a scratch index on origin's tip, so the checkout
 * is never left half-edited, and who the authorities are is read from that
 * tip, under the sync lock, and checked again in the commit to be pushed.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { parse as parseToml } from "smol-toml";

import { ensureGitConfig, git, literal, nulList, ok, out, pullBranch, why } from "../Git.ts";
import { branchPrefix } from "../Names.ts";
import {
  decryptWith,
  encryptedForIn,
  encryptFor,
  keyPath,
  recipientSet,
  recipientsText,
} from "../Secrets.ts";
import { underSyncLock } from "../SyncLock.ts";

const RECIPIENTS = "secrets/recipients.toml";
const SECRETS = "secrets/secrets.env.age";

const parseKeys = (text: string | null) =>
  Effect.try(() => (text === null ? {} : (parseToml(text) as Record<string, unknown>))).pipe(
    Effect.map((raw) =>
      Object.fromEntries(
        Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    ),
    Effect.option,
  );

const sameKeys = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * Whether `commit` takes `node` out of the fleet and does nothing else: it
 * deletes nodes/<node>.toml and, at most, drops `node`'s key from the
 * recipients (comments aside). Its message is not read.
 */
export const isDeparture = (repo: string, commit: string, node: string) =>
  Effect.gen(function* () {
    const changes = nulList(
      (yield* git(repo, ["diff", "--name-status", "-z", "--no-renames", `${commit}^`, commit]))
        .stdout,
    );
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < changes.length; i += 2)
      pairs.push([changes[i] ?? "", changes[i + 1] ?? ""]);
    const own = `nodes/${node}.toml`;
    if (!pairs.some(([status, file]) => status === "D" && file === own)) return false;
    for (const [status, file] of pairs) {
      if (file === own) continue;
      if (file !== RECIPIENTS || status !== "M") return false;
      const show = (rev: string) =>
        git(repo, ["show", `${rev}:${RECIPIENTS}`]).pipe(
          Effect.map((r) => (ok(r) ? r.stdout : null)),
        );
      const before = yield* parseKeys(yield* show(`${commit}^`));
      const after = yield* parseKeys(yield* show(commit));
      if (Option.isNone(before) || Option.isNone(after)) return false;
      const { [node]: _gone, ...rest } = before.value;
      if (!(node in before.value) || !sameKeys(rest, after.value)) return false;
    }
    return true;
  });

/** The staging branch a node proposes from. */
const stagingRef = (node: string) => `refs/heads/${branchPrefix("staging")}${node}`;

/** Each node on `ref` and its roles, read from the commit itself. */
export const rolesAt = (repo: string, ref: string) =>
  Effect.gen(function* () {
    const listed = yield* git(repo, ["ls-tree", "--name-only", `${ref}:nodes`]);
    if (!ok(listed)) return new Map<string, ReadonlyArray<string>>();
    const roles = new Map<string, ReadonlyArray<string>>();
    for (const file of out(listed)
      .split("\n")
      .filter((f) => f.endsWith(".toml"))) {
      const text = yield* git(repo, ["show", `${ref}:nodes/${file}`], { env: literal });
      const parsed = yield* Effect.try(
        () => parseToml(text.stdout) as Record<string, unknown>,
      ).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
      const list = Array.isArray(parsed["roles"])
        ? parsed["roles"].filter((r): r is string => typeof r === "string")
        : ["member"];
      roles.set(file.slice(0, -".toml".length), list);
    }
    return roles;
  });

const authoritiesBesides = (roles: ReadonlyMap<string, ReadonlyArray<string>>, node: string) =>
  [...roles].filter(([n, r]) => n !== node && r.includes("authority")).map(([n]) => n);

/** Where the node stands on origin: still in the fleet, gone, or not known (origin unreachable). */
export type Standing =
  | {
      readonly _tag: "in";
      /** Whether origin's branch makes this node an authority. */
      readonly authority: boolean;
      /** The other authorities on origin's branch. */
      readonly authorities: ReadonlyArray<string>;
      /** The departure this node proposed, still waiting; null when none. */
      readonly proposed: string | null;
    }
  | { readonly _tag: "out" }
  | { readonly _tag: "unknown"; readonly why: string };

export const standing = (repo: string, branch: string, node: string) =>
  Effect.gen(function* () {
    const fetch = yield* git(repo, ["fetch", "-q", "origin", branch]);
    if (!ok(fetch)) return { _tag: "unknown", why: why(fetch) } as Standing;
    const roles = yield* rolesAt(repo, `origin/${branch}`);
    if (!roles.has(node)) return { _tag: "out" } as Standing;
    const ref = stagingRef(node);
    const tip = out(yield* git(repo, ["ls-remote", "origin", ref])).split(/\s+/)[0] ?? "";
    let proposed: string | null = null;
    if (tip !== "" && ok(yield* git(repo, ["fetch", "-q", "origin", ref])))
      if (yield* isDeparture(repo, tip, node)) proposed = tip.slice(0, 7);
    return {
      _tag: "in",
      authority: roles.get(node)?.includes("authority") === true,
      authorities: authoritiesBesides(roles, node),
      proposed,
    } as Standing;
  });

/**
 * A commit on origin's tip without `node`: its node file gone and its key
 * dropped from the recipients. With `reencrypt`, the secrets are encrypted
 * again for the remaining recipients from origin's copy, read with this
 * machine's key (left as they are when it cannot read them).
 */
const removalCommit = (
  repo: string,
  branch: string,
  node: string,
  home: string,
  message: string,
  reencrypt: boolean,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = `origin/${branch}`;
    const env = { GIT_INDEX_FILE: `${repo}/.git/t3-fleet-leave-index`, ...literal };
    const read = yield* git(repo, ["read-tree", base], { env });
    if (!ok(read)) return yield* Effect.fail(`reading ${base}: ${why(read)}`);
    const files = [`nodes/${node}.toml`];
    const rm = yield* git(repo, ["rm", "-q", "--cached", "--", `nodes/${node}.toml`], { env });
    if (!ok(rm)) return yield* Effect.fail(`removing nodes/${node}.toml: ${why(rm)}`);
    const show = (file: string) =>
      git(repo, ["show", `${base}:${file}`]).pipe(Effect.map((r) => (ok(r) ? r.stdout : null)));
    const put = (file: string, text: string) =>
      Effect.gen(function* () {
        const blob = yield* git(repo, ["hash-object", "-w", "--stdin"], { stdin: text });
        if (!ok(blob)) return yield* Effect.fail(`writing ${file}: ${why(blob)}`);
        const update = yield* git(
          repo,
          ["update-index", "--add", "--cacheinfo", `100644,${out(blob)},${file}`],
          { env },
        );
        if (!ok(update)) return yield* Effect.fail(`writing ${file}: ${why(update)}`);
        files.push(file);
      });
    const notes: Array<string> = [];
    const originRecipients = yield* show(RECIPIENTS);
    const recipients =
      originRecipients === null
        ? {}
        : yield* Effect.try(() => parseToml(originRecipients) as Record<string, unknown>).pipe(
            Effect.mapError(() => `${RECIPIENTS} on ${branch} is not valid TOML`),
          );
    if (node in recipients) {
      const rest = Object.fromEntries(
        Object.entries(recipients).filter(
          (e): e is [string, string] => e[0] !== node && typeof e[1] === "string",
        ),
      );
      // The recorded set stays what the secrets were encrypted to, unless they are encrypted again here.
      let recorded = originRecipients === null ? null : encryptedForIn(originRecipients);
      const armored = yield* show(SECRETS);
      if (reencrypt && armored !== null && Object.keys(rest).length > 0) {
        const key = (yield* fs.readFileString(keyPath(home)).pipe(Effect.orElseSucceed(() => "")))
          .split("\n")
          .find((l) => l.startsWith("AGE-SECRET-KEY-"));
        const plain =
          key === undefined ? Option.none() : yield* decryptWith(key, armored).pipe(Effect.option);
        if (Option.isSome(plain)) {
          const sealed = yield* encryptFor(Object.values(rest), plain.value).pipe(
            Effect.mapError((e) => e.message),
          );
          yield* put(SECRETS, sealed);
          recorded = yield* recipientSet(Object.values(rest));
        } else
          notes.push(
            "this machine could not read the secrets, so they stay encrypted as they were; the next `t3-fleet secrets set` encrypts them for the remaining machines only",
          );
      }
      yield* put(RECIPIENTS, recipientsText(rest, recorded));
    }
    const tree = yield* git(repo, ["write-tree"], { env });
    if (!ok(tree)) return yield* Effect.fail(`writing the tree: ${why(tree)}`);
    const commit = yield* git(repo, ["commit-tree", out(tree), "-p", base, "-m", message]);
    if (!ok(commit)) return yield* Effect.fail(`committing: ${why(commit)}`);
    return { commit: out(commit), files, notes };
  });

const errorText = (e: string | { readonly message: string }) =>
  typeof e === "string" ? e : e.message;

const deleteBranches = (repo: string, node: string) =>
  Effect.forEach(
    ["state", "staging", "rejected"] as const,
    (kind) => git(repo, ["push", "-q", "origin", `:refs/heads/${branchPrefix(kind)}${node}`]),
    { discard: true },
  );

/**
 * Removes `node` on origin's branch, as an authority: refuses when it is
 * still there and no other authority would be left, and pushes only a commit
 * that keeps one. A push that loses a race is built again on the new tip.
 */
export const removeNode = (
  repo: string,
  branch: string,
  node: string,
  home: string,
  message: string,
): Effect.Effect<
  { readonly rev: string | null; readonly notes: ReadonlyArray<string> },
  string,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  underSyncLock(
    Effect.gen(function* () {
      yield* ensureGitConfig;
      for (let attempt = 1; ; attempt++) {
        const now = yield* standing(repo, branch, node);
        if (now._tag === "unknown")
          return yield* Effect.fail(`cannot reach the config repo's origin: ${now.why}`);
        if (now._tag === "out") {
          yield* deleteBranches(repo, node);
          return { rev: null, notes: [] as ReadonlyArray<string> };
        }
        if (now.authorities.length === 0)
          return yield* Effect.fail(
            `${node} is the fleet's only authority on ${branch}; give another machine the authority role first`,
          );
        const built = yield* removalCommit(repo, branch, node, home, message, true);
        // Checked again in what is about to be pushed, not in what was fetched.
        const after = yield* rolesAt(repo, built.commit);
        if (after.has(node) || authoritiesBesides(after, node).length === 0)
          return yield* Effect.fail(`the removal would leave ${branch} without an authority`);
        const push = yield* git(repo, [
          "push",
          "-q",
          "origin",
          `${built.commit}:refs/heads/${branch}`,
        ]);
        if (!ok(push)) {
          if (attempt < 3) continue;
          return yield* Effect.fail(`pushing the removal failed: ${why(push)}`);
        }
        yield* deleteBranches(repo, node);
        // The checkout follows when it can; it is the user's to keep.
        yield* pullBranch(repo, branch, "ff-only").pipe(Effect.ignore);
        return { rev: built.commit.slice(0, 7), notes: built.notes };
      }
    }),
  ).pipe(Effect.mapError(errorText));

/**
 * Proposes `node`'s removal for an authority to approve; returns the
 * commit, or null when the node is out already. Run under the lock.
 */
const proposeDeparture = (repo: string, branch: string, node: string, home: string) =>
  Effect.gen(function* () {
    const now = yield* standing(repo, branch, node);
    if (now._tag === "unknown")
      return yield* Effect.fail(`cannot reach the config repo's origin: ${now.why}`);
    if (now._tag === "out") return null;
    if (now.proposed !== null) return now.proposed;
    // The secrets are left to the authority approving it: it re-encrypts its own current copy.
    const built = yield* removalCommit(
      repo,
      branch,
      node,
      home,
      `Proposed by ${node}: remove ${node} from the fleet`,
      false,
    );
    const push = yield* git(repo, [
      "push",
      "-q",
      "--force",
      "origin",
      `${built.commit}:${stagingRef(node)}`,
    ]);
    if (!ok(push)) return yield* Effect.fail(`proposing the removal failed: ${why(push)}`);
    return built.commit.slice(0, 7);
  });

export type Left =
  | { readonly _tag: "removed"; readonly rev: string | null; readonly notes: ReadonlyArray<string> }
  | { readonly _tag: "proposed"; readonly commit: string | null };

/**
 * Takes `node` out of the fleet the way origin's branch says it may, now: as
 * an authority (refused when it is the only one), or by proposing it.
 */
export const leaveFleet = (
  repo: string,
  branch: string,
  node: string,
  home: string,
): Effect.Effect<Left, string, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  underSyncLock(
    Effect.gen(function* () {
      yield* ensureGitConfig;
      const now = yield* standing(repo, branch, node);
      if (now._tag === "unknown")
        return yield* Effect.fail(`cannot reach the config repo's origin: ${now.why}`);
      if (now._tag === "in" && now.authority) {
        const removed = yield* removeNode(
          repo,
          branch,
          node,
          home,
          `Remove ${node} from the fleet`,
        );
        return { _tag: "removed", ...removed } as Left;
      }
      if (now._tag === "out") return { _tag: "removed", rev: null, notes: [] } as Left;
      return {
        _tag: "proposed",
        commit: yield* proposeDeparture(repo, branch, node, home),
      } as Left;
    }),
  ).pipe(Effect.mapError(errorText));

/** Whether a node's staging branch holds its departure: sync leaves those alone. */
export const isDepartureProposal = (repo: string, node: string, tip: string) =>
  Effect.gen(function* () {
    if (!ok(yield* git(repo, ["cat-file", "-e", `${tip}^{commit}`])))
      yield* git(repo, ["fetch", "-q", "origin", stagingRef(node)]);
    return yield* isDeparture(repo, tip, node);
  });
