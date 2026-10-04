/**
 * Taking a node out of the fleet's config repo.
 *
 *   an authority leaving   commits the removal on top of origin's branch
 *                          itself and pushes it, refusing when no other
 *                          authority would be left
 *   a member leaving       proposes it on t3-fleet/staging/<node>, a commit
 *                          marked as a departure (DEPARTURE_TRAILER), which
 *                          ordinary syncs never replace or withdraw
 *   approving a departure  the authority removes the node the same way, from
 *                          its own current copy of the repo and secrets
 *                          (Staging.approve), so nothing the member proposed
 *                          has to merge, and the member can be gone
 *
 * Every removal is built in a scratch index on origin's tip, so the checkout
 * is never left half-edited, and who the authorities are is read from that
 * tip, under the sync lock, and checked again in the commit to be pushed.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { ensureGitConfig, git, literal, ok, out, pullBranch, why } from "../Git.ts";
import { branchPrefix } from "../Names.ts";
import { decryptWith, encryptFor, keyPath } from "../Secrets.ts";
import { underSyncLock } from "../SyncLock.ts";

export const DEPARTURE_TRAILER = "T3-Fleet-Departure";

const RECIPIENTS = "secrets/recipients.toml";
const SECRETS = "secrets/secrets.env.age";
const RECIPIENTS_HEADER = "# Public age keys of the nodes that can read secrets.env.age.\n";

/** Whether `commit` is a departure proposal, and whose. */
export const departureOf = (repo: string, commit: string) =>
  git(repo, ["log", "-1", "--format=%B", commit]).pipe(
    Effect.map((r) =>
      ok(r)
        ? (new RegExp(`^${DEPARTURE_TRAILER}: ([a-z0-9][a-z0-9-]*)$`, "m").exec(r.stdout)?.[1] ??
          null)
        : null,
    ),
  );

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
    const ref = `refs/heads/${branchPrefix("staging")}${node}`;
    const tip = out(yield* git(repo, ["ls-remote", "origin", ref])).split(/\s+/)[0] ?? "";
    let proposed: string | null = null;
    if (tip !== "" && ok(yield* git(repo, ["fetch", "-q", "origin", ref])))
      if ((yield* departureOf(repo, tip)) === node) proposed = tip.slice(0, 7);
    return { _tag: "in", authorities: authoritiesBesides(roles, node), proposed } as Standing;
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
    const recipientsText = yield* show(RECIPIENTS);
    const recipients =
      recipientsText === null
        ? {}
        : yield* Effect.try(() => parseToml(recipientsText) as Record<string, unknown>).pipe(
            Effect.mapError(() => `${RECIPIENTS} on ${branch} is not valid TOML`),
          );
    if (node in recipients) {
      const rest = Object.fromEntries(
        Object.entries(recipients)
          .filter((e): e is [string, string] => e[0] !== node && typeof e[1] === "string")
          .sort(([a], [b]) => a.localeCompare(b)),
      );
      yield* put(RECIPIENTS, `${RECIPIENTS_HEADER}${stringifyToml(rest)}\n`);
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
        } else
          notes.push(
            "this machine could not read the secrets, so they stay encrypted as they were; the next `t3-fleet secrets set` encrypts them for the remaining machines only",
          );
      }
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

/** Proposes `node`'s removal for an authority to approve; returns the commit. */
export const proposeDeparture = (repo: string, branch: string, node: string, home: string) =>
  underSyncLock(
    Effect.gen(function* () {
      yield* ensureGitConfig;
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
        `Proposed by ${node}: remove ${node} from the fleet\n\n${DEPARTURE_TRAILER}: ${node}`,
        false,
      );
      const ref = `refs/heads/${branchPrefix("staging")}${node}`;
      const push = yield* git(repo, ["push", "-q", "--force", "origin", `${built.commit}:${ref}`]);
      if (!ok(push)) return yield* Effect.fail(`proposing the removal failed: ${why(push)}`);
      return built.commit.slice(0, 7);
    }),
  ).pipe(Effect.mapError(errorText));

/** Whether a staging branch's tip is a departure: sync leaves those alone. */
export const isDepartureProposal = (repo: string, ref: string, tip: string) =>
  Effect.gen(function* () {
    if (!ok(yield* git(repo, ["cat-file", "-e", `${tip}^{commit}`])))
      yield* git(repo, ["fetch", "-q", "origin", ref]);
    return (yield* departureOf(repo, tip)) !== null;
  });
