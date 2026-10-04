/**
 * The git T3 Fleet runs. It never reads the user's global git config: a rule
 * there rewriting GitHub HTTPS to SSH made every unattended fetch fail, since
 * a timer has no SSH agent. Instead GIT_CONFIG_GLOBAL points at
 * ~/.config/t3-fleet/gitconfig, which holds only an identity and a credential
 * helper, and prompts are off so a missing credential fails fast.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { exec, type ExecResult } from "./Exec.ts";
import { configDir } from "./Names.ts";
import { underSyncLock } from "./SyncLock.ts";

export const gitConfigPath = (home: string) => `${configDir(home)}/gitconfig`;

/**
 * `repo`, when given, is trusted regardless of who owns it: git's ownership
 * check (safe.directory) normally lives in the global config T3 Fleet skips.
 */
export const gitEnv = (home: string, env: Readonly<Record<string, string | undefined>>, repo?: string) => ({
  ...env,
  GIT_CONFIG_GLOBAL: gitConfigPath(home),
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  ...(repo === undefined ? {} : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: repo }),
});

export const git = (
  dir: string,
  args: ReadonlyArray<string>,
  options: { readonly stdin?: string; readonly timeout?: Duration.Input; readonly env?: Readonly<Record<string, string>> } = {},
) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    return yield* exec({
      command: "git",
      args: ["-C", dir, ...args],
      env: { ...gitEnv(home, process.env, dir), ...options.env },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      timeout: options.timeout ?? Duration.seconds(60),
    });
  });

export const ok = (r: ExecResult) => r.code === 0;
export const out = (r: ExecResult) => r.stdout.trim();
export const why = (r: ExecResult) => (r.stderr.trim().split("\n").filter(Boolean).pop() ?? r.spawnError ?? `exit ${r.code}`).slice(0, 240);

/**
 * Write T3 Fleet's git config: the user's name and email (read once from their
 * own config) and gh as the credential helper for GitHub when gh is present.
 */
export const ensureGitConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = process.env["HOME"] ?? "";
  const path = gitConfigPath(home);
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return path;
  const get = (key: string) => exec({ command: "git", args: ["config", "--global", key], timeout: Duration.seconds(5) }).pipe(Effect.map((r) => r.stdout.trim()));
  const name = (yield* get("user.name")) || "T3 Fleet";
  const email = (yield* get("user.email")) || "t3-fleet@localhost";
  const gh = yield* exec({ command: "sh", args: ["-c", "command -v gh"], timeout: Duration.seconds(5) });
  const lines = ["[user]", `\tname = ${name}`, `\temail = ${email}`];
  if (gh.code === 0) {
    const ghPath = gh.stdout.trim();
    lines.push('[credential "https://github.com"]', "\thelper =", `\thelper = !${ghPath} auth git-credential`);
  }
  yield* fs.makeDirectory(configDir(home), { recursive: true }).pipe(Effect.ignore);
  yield* fs.writeFileString(path, lines.join("\n") + "\n");
  return path;
});

/** For commands given file names: a name is a name, never a glob or `:(magic)`. */
export const literal = { GIT_LITERAL_PATHSPECS: "1" } as const;

/** Paths `-z` output lists, NUL-separated and never quoted. */
export const nulList = (stdout: string) => stdout.split("\0").filter(Boolean);

/**
 * `git status --porcelain -z` as entries. A rename or copy names its source
 * too; both count as changed.
 */
export const statusEntries = (stdout: string) => {
  const parts = stdout.split("\0");
  const entries: Array<{ readonly xy: string; readonly path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (part === "") continue;
    const xy = part.slice(0, 2);
    entries.push({ xy, path: part.slice(3) });
    if (/[RC]/.test(xy)) entries.push({ xy, path: parts[++i] ?? "" });
  }
  return entries.filter((e) => e.path !== "");
};

/** Changed or new files under `paths` (all of the checkout when empty), as git sees them. */
export const changedFiles = (repo: string, paths: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const status = yield* git(repo, ["status", "--porcelain", "-z", "-uall", "--", ...paths], { env: literal });
    return [...new Set(statusEntries(status.stdout).map((e) => e.path))];
  });

/** Files a merge, rebase or stash left conflicted. */
export const unmergedFiles = (repo: string) =>
  git(repo, ["diff", "--name-only", "-z", "--diff-filter=U"]).pipe(Effect.map((r) => [...new Set(nulList(r.stdout))]));

/**
 * Bring the checkout up to origin/<branch>: rebase this node's own commits
 * onto it (an authority), or fast-forward (any other node, which never
 * commits). Refuses when an uncommitted edit touches an incoming file, and
 * fails rather than leave a conflict in a live file. The commits it pulled.
 */
export const pullBranch = (repo: string, branch: string, how: "rebase" | "ff-only") =>
  Effect.gen(function* () {
    const fetch = yield* git(repo, ["fetch", "-q", "origin", branch]);
    if (!ok(fetch)) return yield* Effect.fail(`fetch failed: ${why(fetch)}`);
    const behind = Number(out(yield* git(repo, ["rev-list", "--count", `HEAD..origin/${branch}`])));
    if (behind === 0) return 0;
    const status = yield* git(repo, ["status", "--porcelain", "-z", "-uall"]);
    const dirty = new Map(statusEntries(status.stdout).map((e) => [e.path, e.xy] as const));
    const incoming = nulList((yield* git(repo, ["diff", "--name-only", "-z", "--no-renames", `HEAD...origin/${branch}`])).stdout);
    const overlap: Array<string> = [];
    for (const file of incoming.filter((f) => dirty.has(f))) {
      // A local edit identical to what arrives (an approved proposal coming
      // back) is not a conflict: drop the local copy and take the branch's.
      const local = out(yield* git(repo, ["hash-object", "--", file]));
      const remote = out(yield* git(repo, ["rev-parse", `origin/${branch}:${file}`]));
      if (local !== "" && local === remote) {
        if (dirty.get(file) === "??") yield* git(repo, ["clean", "-q", "-f", "--", file], { env: literal });
        else yield* git(repo, ["checkout", "-q", "HEAD", "--", file], { env: literal });
        continue;
      }
      overlap.push(file);
    }
    if (overlap.length > 0) return yield* Effect.fail(`local edits overlap incoming changes: ${overlap.join(", ")}`);
    const move =
      how === "rebase"
        ? yield* git(repo, ["rebase", "-q", "--autostash", `origin/${branch}`])
        : yield* git(repo, ["merge", "-q", "--ff-only", "--autostash", `origin/${branch}`]);
    if (!ok(move)) {
      if (how === "rebase") yield* git(repo, ["rebase", "--abort"]);
      return yield* Effect.fail(
        how === "rebase" ? `rebase onto origin/${branch} conflicted; resolve by hand` : `cannot fast-forward to origin/${branch}: ${why(move)}`,
      );
    }
    // Putting the local edits back can still conflict, and git calls that
    // success. Never leave conflict markers in a live file: take the branch's
    // version there; the edits stay in git stash.
    const conflicted = yield* unmergedFiles(repo);
    if (conflicted.length > 0) {
      yield* git(repo, ["reset", "-q", "--", ...conflicted], { env: literal });
      yield* git(repo, ["checkout", "-q", "HEAD", "--", ...conflicted], { env: literal });
      return yield* Effect.fail(`local edits to ${conflicted.join(", ")} conflicted with incoming changes; they are kept in git stash`);
    }
    return behind;
  });

/**
 * `git add -A` exactly `paths`. A path already gone from the checkout and the
 * index (git rm) is left out: git add cannot name it, and a commit of the
 * paths records it anyway.
 */
export const addPaths = (repo: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const present: Array<string> = [];
    for (const p of paths) {
      const indexed = out(yield* git(repo, ["ls-files", "--", p], { env: literal })) !== "";
      if (indexed || (yield* fs.exists(`${repo}/${p}`).pipe(Effect.orElseSucceed(() => false)))) present.push(p);
    }
    if (present.length === 0) return;
    const add = yield* git(repo, ["add", "-A", "--", ...present], { env: literal });
    if (!ok(add)) return yield* Effect.fail(`git add failed: ${why(add)}`);
  });

/** The branch the checkout tracks on origin: main, usually. */
const upstreamBranch = (repo: string) =>
  Effect.gen(function* () {
    const upstream = out(yield* git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
    if (upstream.startsWith("origin/")) return upstream.slice("origin/".length);
    return out(yield* git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]));
  });

/**
 * Commit `paths` in the repo and push, as an authority changing the config.
 * Pulls first (rebase) so the push lands on what other nodes see. Takes the
 * sync lock, so callers that write files before this should hold it too.
 */
export const commitAndPush = (repo: string, paths: ReadonlyArray<string>, message: string) =>
  underSyncLock(
    Effect.gen(function* () {
      yield* ensureGitConfig;
      yield* addPaths(repo, paths);
      const staged = nulList((yield* git(repo, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--", ...paths], { env: literal })).stdout);
      if (staged.length === 0) return "nothing to commit";
      const commit = yield* git(repo, ["commit", "-q", "-m", message, "--", ...staged], { env: literal });
      if (!ok(commit)) return yield* Effect.fail(`git commit failed: ${why(commit)}`);
      yield* pullBranch(repo, yield* upstreamBranch(repo), "rebase").pipe(
        Effect.mapError((e) => `committed, but pulling before the push failed: ${e}`),
      );
      const push = yield* git(repo, ["push", "-q"]);
      if (!ok(push)) return yield* Effect.fail(`committed, but the push failed: ${why(push)}`);
      return out(yield* git(repo, ["rev-parse", "--short", "HEAD"]));
    }),
  );
