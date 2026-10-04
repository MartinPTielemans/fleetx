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
import {
  addedLines,
  parseAllowed,
  readAllowed,
  refusal,
  settle,
  suspectLines,
  type Allowed,
  type SecretHit,
  type Suspect,
} from "./SecretScan.ts";
import { underSyncLock } from "./SyncLock.ts";

export const gitConfigPath = (home: string) => `${configDir(home)}/gitconfig`;

/**
 * `repo`, when given, is trusted regardless of who owns it: git's ownership
 * check (safe.directory) normally lives in the global config T3 Fleet skips.
 */
export const gitEnv = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  repo?: string,
) => ({
  ...env,
  GIT_CONFIG_GLOBAL: gitConfigPath(home),
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  ...(repo === undefined
    ? {}
    : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: repo }),
});

export const git = (
  dir: string,
  args: ReadonlyArray<string>,
  options: {
    readonly stdin?: string;
    readonly timeout?: Duration.Input;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
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
export const why = (r: ExecResult) =>
  (r.stderr.trim().split("\n").filter(Boolean).pop() ?? r.spawnError ?? `exit ${r.code}`).slice(
    0,
    240,
  );

/**
 * Write T3 Fleet's git config: the user's name and email (read once from their
 * own config) and gh as the credential helper for GitHub when gh is present.
 */
export const ensureGitConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = process.env["HOME"] ?? "";
  const path = gitConfigPath(home);
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return path;
  const get = (key: string) =>
    exec({ command: "git", args: ["config", "--global", key], timeout: Duration.seconds(5) }).pipe(
      Effect.map((r) => r.stdout.trim()),
    );
  const name = (yield* get("user.name")) || "T3 Fleet";
  const email = (yield* get("user.email")) || "t3-fleet@localhost";
  const gh = yield* exec({
    command: "sh",
    args: ["-c", "command -v gh"],
    timeout: Duration.seconds(5),
  });
  const lines = ["[user]", `\tname = ${name}`, `\temail = ${email}`];
  if (gh.code === 0) {
    const ghPath = gh.stdout.trim();
    lines.push(
      '[credential "https://github.com"]',
      "\thelper =",
      `\thelper = !${ghPath} auth git-credential`,
    );
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
    const status = yield* git(repo, ["status", "--porcelain", "-z", "-uall", "--", ...paths], {
      env: literal,
    });
    return [...new Set(statusEntries(status.stdout).map((e) => e.path))];
  });

/** Files a merge, rebase or stash left conflicted. */
export const unmergedFiles = (repo: string) =>
  git(repo, ["diff", "--name-only", "-z", "--diff-filter=U"]).pipe(
    Effect.map((r) => [...new Set(nulList(r.stdout))]),
  );

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
    const incoming = nulList(
      (yield* git(repo, ["diff", "--name-only", "-z", "--no-renames", `HEAD...origin/${branch}`]))
        .stdout,
    );
    const overlap: Array<string> = [];
    for (const file of incoming.filter((f) => dirty.has(f))) {
      // A local edit identical to what arrives (an approved proposal coming
      // back) is not a conflict: drop the local copy and take the branch's.
      const local = out(yield* git(repo, ["hash-object", "--", file]));
      const remote = out(yield* git(repo, ["rev-parse", `origin/${branch}:${file}`]));
      if (local !== "" && local === remote) {
        if (dirty.get(file) === "??")
          yield* git(repo, ["clean", "-q", "-f", "--", file], { env: literal });
        else yield* git(repo, ["checkout", "-q", "HEAD", "--", file], { env: literal });
        continue;
      }
      overlap.push(file);
    }
    if (overlap.length > 0)
      return yield* Effect.fail(`local edits overlap incoming changes: ${overlap.join(", ")}`);
    const move =
      how === "rebase"
        ? yield* git(repo, ["rebase", "-q", "--autostash", `origin/${branch}`])
        : // No --autostash (git 2.27+): a fast-forward leaves local edits alone, and none touches an incoming file.
          yield* git(repo, ["merge", "-q", "--ff-only", `origin/${branch}`]);
    if (!ok(move)) {
      if (how === "rebase") yield* git(repo, ["rebase", "--abort"]);
      return yield* Effect.fail(
        how === "rebase"
          ? `rebase onto origin/${branch} conflicted; resolve by hand`
          : `cannot fast-forward to origin/${branch}: ${why(move)}`,
      );
    }
    // Putting the local edits back can still conflict, and git calls that
    // success. Never leave conflict markers in a live file: take the branch's
    // version there; the edits stay in git stash.
    const conflicted = yield* putBackConflicted(repo);
    if (conflicted.length > 0) {
      return yield* Effect.fail(
        `local edits to ${conflicted.join(", ")} conflicted with incoming changes; they are kept in git stash`,
      );
    }
    return behind;
  });

/**
 * Every conflicted file back to HEAD's version, one at a time: a file HEAD
 * does not have (deleted there, or added only by the other side) is removed,
 * and one failing never leaves the others with conflict markers. The files.
 */
export const putBackConflicted = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const conflicted = yield* unmergedFiles(repo);
    for (const file of conflicted) {
      yield* git(repo, ["reset", "-q", "--", file], { env: literal });
      if (ok(yield* git(repo, ["cat-file", "-e", `HEAD:${file}`])))
        yield* git(repo, ["checkout", "-q", "HEAD", "--", file], { env: literal });
      else yield* fs.remove(`${repo}/${file}`, { force: true }).pipe(Effect.ignore);
    }
    return conflicted;
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
      if (indexed || (yield* fs.exists(`${repo}/${p}`).pipe(Effect.orElseSucceed(() => false))))
        present.push(p);
    }
    if (present.length === 0) return;
    const add = yield* git(repo, ["add", "-A", "--", ...present], { env: literal });
    if (!ok(add)) return yield* Effect.fail(`git add failed: ${why(add)}`);
  });

/**
 * What a diff adds that looks like a secret. `range` is git diff's own
 * (["--cached", "HEAD"], ["origin/main", "HEAD"]); `side` is where the new
 * version of a file is read, to know an age file by its first line.
 */
const scanDiff = (
  repo: string,
  range: ReadonlyArray<string>,
  side: string,
  options: {
    readonly paths?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
    readonly allowed?: ReadonlyArray<Allowed>;
  },
) =>
  Effect.gen(function* () {
    const env = { ...literal, ...options.env };
    const diff = yield* git(
      repo,
      [
        "-c",
        "core.quotepath=off",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-renames",
        "-U0",
        ...range,
        "--",
        ...(options.paths ?? []),
      ],
      { env },
    );
    if (!ok(diff)) return yield* Effect.fail(`scanning for secrets: ${why(diff)}`);
    const suspects: Array<Suspect> = [];
    for (const [file, lines] of addedLines(diff.stdout)) {
      let found = suspectLines(file, lines);
      // Only the first line says whether the file is an age file; read it when the diff lacks it.
      if (found.length > 0 && !lines.some((l) => l.line === 1)) {
        const first = out(yield* git(repo, ["show", `${side}${file}`], { env })).split("\n")[0];
        found = suspectLines(file, lines, first ?? null);
      }
      suspects.push(...found);
    }
    if (suspects.length === 0) return [] as Array<SecretHit>;
    return yield* settle(suspects, options.allowed ?? (yield* readAllowed(repo)));
  });

/**
 * What the index (or the one `env` names) adds against `base`, HEAD by
 * default (every staged line, in a repo without commits), that looks like a
 * secret. The allow-list is the checkout's own t3-fleet.toml unless given.
 */
export const scanStaged = (
  repo: string,
  options: {
    readonly base?: string;
    readonly paths?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
    readonly allowed?: ReadonlyArray<Allowed>;
  } = {},
) =>
  scanDiff(repo, ["--cached", ...(options.base === undefined ? [] : [options.base])], ":", options);

/** git's empty tree: what a root commit is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * What each commit in `range` (rev-list's: `origin/main..HEAD`, or `HEAD`
 * for a branch nothing has seen) adds that looks like a secret, commits made
 * by hand too, each named. Commit by commit: one that adds a token and a
 * later one that takes it out still put it in history. A root commit is
 * compared with nothing; a merge only for what it adds itself, which no
 * parent had.
 */
export const scanCommits = (
  repo: string,
  range: ReadonlyArray<string>,
  options: { readonly allowed?: ReadonlyArray<Allowed> } = {},
) =>
  Effect.gen(function* () {
    const list = yield* git(repo, ["rev-list", "--reverse", "--parents", ...range]);
    if (!ok(list)) return yield* Effect.fail(`scanning for secrets: ${why(list)}`);
    const allowed = options.allowed ?? (yield* readAllowed(repo));
    const hits: Array<SecretHit> = [];
    for (const line of out(list).split("\n").filter(Boolean)) {
      const [commit = "", ...parents] = line.split(" ");
      const against = parents.length === 0 ? [EMPTY_TREE] : parents;
      let found: ReadonlyArray<SecretHit> | null = null;
      for (const parent of against) {
        const next = yield* scanDiff(repo, [parent, commit], `${commit}:`, { allowed });
        const same = (h: SecretHit) => `${h.file}\0${h.hash}`;
        found = found === null ? next : found.filter((h) => next.some((n) => same(n) === same(h)));
      }
      hits.push(...(found ?? []).map((h) => ({ ...h, commit: commit.slice(0, 7) })));
    }
    return hits;
  });

/**
 * What the checkout's edits to `paths` (new files too) would add against
 * `base`, built in a scratch index so neither the real index nor the
 * working tree is touched.
 */
export const scanEdits = (
  repo: string,
  paths: ReadonlyArray<string>,
  options: { readonly base?: string; readonly allowed?: ReadonlyArray<Allowed> } = {},
) =>
  Effect.gen(function* () {
    if (paths.length === 0) return [] as Array<SecretHit>;
    const base = options.base ?? "HEAD";
    const env = { GIT_INDEX_FILE: `${repo}/.git/t3-fleet-scan-index`, ...literal };
    const read = yield* git(repo, ["read-tree", base], { env });
    if (!ok(read)) return yield* Effect.fail(`scanning for secrets: ${why(read)}`);
    yield* git(repo, ["add", "-A", "--", ...paths], { env });
    return yield* scanStaged(repo, { ...options, base, paths, env });
  });

/** t3-fleet.toml's allow_secret entries as committed at `ref`: what a member trusts. */
export const allowedAt = (repo: string, ref: string) =>
  git(repo, ["show", `${ref}:t3-fleet.toml`]).pipe(
    Effect.flatMap((r) => parseAllowed(ok(r) ? r.stdout : "")),
  );

/**
 * The checkout's files under `paths` as they are now, edits and new files
 * included, as a git tree: what a command that is about to write there can
 * put back with restorePaths. Nothing in the checkout or its index changes.
 */
export const snapshot = (repo: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const env = { GIT_INDEX_FILE: `${repo}/.git/t3-fleet-snapshot-index`, ...literal };
    const read = yield* git(repo, ["read-tree", "HEAD"], { env });
    if (!ok(read)) return yield* Effect.fail(`taking a snapshot: ${why(read)}`);
    const add = yield* git(repo, ["add", "-A", "--", ...paths], { env });
    if (!ok(add)) return yield* Effect.fail(`taking a snapshot: ${why(add)}`);
    return out(yield* git(repo, ["write-tree"], { env }));
  });

/**
 * Put `paths` back as `tree` (a snapshot) has them, HEAD by default, new
 * files removed: for undoing what a refused command wrote. Edits made before
 * the snapshot stay; without one, `paths` must be files the command wrote.
 */
export const restorePaths = (repo: string, paths: ReadonlyArray<string>, tree = "HEAD") =>
  Effect.gen(function* () {
    if (paths.length === 0) return;
    const fs = yield* FileSystem.FileSystem;
    yield* git(repo, ["reset", "-q", "--", ...paths], { env: literal });
    // What git sees goes; what it ignores (a skill's .env) stays, as git clean without -x leaves it.
    const tracked = nulList(
      (yield* git(repo, ["ls-files", "-z", "--", ...paths], { env: literal })).stdout,
    );
    for (const file of tracked) yield* fs.remove(`${repo}/${file}`, { force: true });
    yield* git(repo, ["clean", "-q", "-f", "-d", "--", ...paths], { env: literal });
    const kept = nulList(
      (yield* git(repo, ["ls-tree", "-r", "-z", "--name-only", tree, "--", ...paths], {
        env: literal,
      })).stdout,
    );
    if (kept.length > 0) {
      const back = yield* git(repo, ["checkout", "-q", tree, "--", ...kept], { env: literal });
      if (!ok(back)) return yield* Effect.fail(`putting ${paths.join(", ")} back: ${why(back)}`);
      // checkout stages what it writes: the index goes back to HEAD's.
      yield* git(repo, ["reset", "-q", "--", ...kept], { env: literal });
    }
  });

/** Files under `paths` (all when empty) git still has as conflicted, as hits naming each. */
export const unmergedHits = (repo: string, paths: ReadonlyArray<string> = []) =>
  unmergedFiles(repo).pipe(
    Effect.map((files) =>
      files
        .filter((f) => paths.length === 0 || paths.some((p) => f === p || f.startsWith(`${p}/`)))
        .map((file): SecretHit => ({
          file,
          line: 0,
          kind: "an unresolved merge conflict",
          hash: "",
        })),
    ),
  );

/**
 * Fail, naming them, when the staged `paths` add a secret; they are unstaged
 * again (the edits stay in the checkout) so nothing commits them by accident.
 */
export const refuseSecrets = (repo: string, paths: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const hits = yield* scanStaged(repo, { paths });
    if (hits.length === 0) return;
    const head = ok(yield* git(repo, ["rev-parse", "-q", "--verify", "HEAD"]));
    yield* git(
      repo,
      head
        ? ["reset", "-q", "--", ...paths]
        : ["rm", "-rq", "--cached", "--", ...(paths.length > 0 ? paths : ["."])],
      { env: literal },
    );
    return yield* Effect.fail(refusal(hits));
  });

/** The branch the checkout tracks on origin: main, usually. */
const upstreamBranch = (repo: string) =>
  Effect.gen(function* () {
    const upstream = out(
      yield* git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    );
    if (upstream.startsWith("origin/")) return upstream.slice("origin/".length);
    return out(yield* git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]));
  });

/**
 * Commit `paths` in the repo and push, as an authority changing the config.
 * Pulls first (rebase) so the push lands on what other nodes see. Takes the
 * sync lock, so callers that write files before this should hold it too.
 * Refuses, committing nothing, when what it adds looks like a secret, and
 * pushing nothing when an unpushed commit made by hand does.
 */
export const commitAndPush = (repo: string, paths: ReadonlyArray<string>, message: string) =>
  underSyncLock(
    Effect.gen(function* () {
      yield* ensureGitConfig;
      // Adding a conflicted file would mark it resolved, markers and all.
      const conflicted = yield* unmergedHits(repo, paths);
      if (conflicted.length > 0)
        return yield* Effect.fail(
          `refusing to commit: ${conflicted.map((h) => h.file).join(", ")} still conflicted; resolve by hand first`,
        );
      yield* addPaths(repo, paths);
      const staged = nulList(
        (yield* git(
          repo,
          ["diff", "--cached", "--name-only", "-z", "--no-renames", "--", ...paths],
          { env: literal },
        )).stdout,
      );
      if (staged.length === 0) return "nothing to commit";
      yield* refuseSecrets(repo, staged);
      const commit = yield* git(repo, ["commit", "-q", "-m", message, "--", ...staged], {
        env: literal,
      });
      if (!ok(commit)) return yield* Effect.fail(`git commit failed: ${why(commit)}`);
      const branch = yield* upstreamBranch(repo);
      // A remote nothing was pushed to yet (a fleet's first commit): nothing to pull.
      const empty =
        (yield* git(repo, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`])).code ===
        2;
      if (!empty)
        yield* pullBranch(repo, branch, "rebase").pipe(
          Effect.mapError((e) => `committed, but pulling before the push failed: ${e}`),
        );
      // A commit made here by hand rides along with the push: it is checked too.
      const unpushed = yield* scanCommits(repo, empty ? ["HEAD"] : [`origin/${branch}..HEAD`]);
      if (unpushed.length > 0)
        return yield* Effect.fail(
          `committed, but not pushed: a commit here that ${branch} lacks adds what looks like a secret\n${refusal(unpushed, "push")}`,
        );
      const push = yield* git(
        repo,
        empty ? ["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`] : ["push", "-q"],
      );
      if (!ok(push)) return yield* Effect.fail(`committed, but the push failed: ${why(push)}`);
      return out(yield* git(repo, ["rev-parse", "--short", "HEAD"]));
    }),
  );
