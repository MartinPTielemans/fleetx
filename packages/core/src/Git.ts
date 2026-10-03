/**
 * The git fleetx runs. It never reads the user's global git config: a rule
 * there rewriting GitHub HTTPS to SSH made every unattended fetch fail, since
 * a timer has no SSH agent. Instead GIT_CONFIG_GLOBAL points at
 * ~/.config/fleetx/gitconfig, which holds only an identity and a credential
 * helper, and prompts are off so a missing credential fails fast.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { exec, type ExecResult } from "./Exec.ts";

export const gitConfigPath = (home: string) => `${home}/.config/fleetx/gitconfig`;

/**
 * `repo`, when given, is trusted regardless of who owns it: git's ownership
 * check (safe.directory) normally lives in the global config fleetx skips.
 */
export const gitEnv = (home: string, env: Readonly<Record<string, string | undefined>>, repo?: string) => ({
  ...env,
  GIT_CONFIG_GLOBAL: gitConfigPath(home),
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  ...(repo === undefined ? {} : { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: repo }),
});

export const git = (dir: string, args: ReadonlyArray<string>, options: { readonly stdin?: string; readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    return yield* exec({
      command: "git",
      args: ["-C", dir, ...args],
      env: gitEnv(home, process.env, dir),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      timeout: options.timeout ?? Duration.seconds(60),
    });
  });

export const ok = (r: ExecResult) => r.code === 0;
export const out = (r: ExecResult) => r.stdout.trim();
export const why = (r: ExecResult) => (r.stderr.trim().split("\n").filter(Boolean).pop() ?? r.spawnError ?? `exit ${r.code}`).slice(0, 240);

/**
 * Write fleetx's git config: the user's name and email (read once from their
 * own config) and gh as the credential helper for GitHub when gh is present.
 */
export const ensureGitConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = process.env["HOME"] ?? "";
  const path = gitConfigPath(home);
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return path;
  const get = (key: string) => exec({ command: "git", args: ["config", "--global", key], timeout: Duration.seconds(5) }).pipe(Effect.map((r) => r.stdout.trim()));
  const name = (yield* get("user.name")) || "fleetx";
  const email = (yield* get("user.email")) || "fleetx@localhost";
  const gh = yield* exec({ command: "sh", args: ["-c", "command -v gh"], timeout: Duration.seconds(5) });
  const lines = ["[user]", `\tname = ${name}`, `\temail = ${email}`];
  if (gh.code === 0) {
    const ghPath = gh.stdout.trim();
    lines.push('[credential "https://github.com"]', "\thelper =", `\thelper = !${ghPath} auth git-credential`);
  }
  yield* fs.makeDirectory(`${home}/.config/fleetx`, { recursive: true }).pipe(Effect.ignore);
  yield* fs.writeFileString(path, lines.join("\n") + "\n");
  return path;
});

/**
 * Commit `paths` in the repo and push, as an authority changing the config.
 * Pulls first (rebase) so the push lands on what other nodes see.
 */
export const commitAndPush = (repo: string, paths: ReadonlyArray<string>, message: string) =>
  Effect.gen(function* () {
    yield* ensureGitConfig;
    const add = yield* git(repo, ["add", "--", ...paths]);
    if (!ok(add)) return yield* Effect.fail(`git add failed: ${why(add)}`);
    const staged = yield* git(repo, ["diff", "--cached", "--quiet", "--", ...paths]);
    if (staged.code === 0) return "nothing to commit";
    const commit = yield* git(repo, ["commit", "-q", "-m", message, "--", ...paths]);
    if (!ok(commit)) return yield* Effect.fail(`git commit failed: ${why(commit)}`);
    const pull = yield* git(repo, ["pull", "-q", "--rebase", "--autostash"]);
    if (!ok(pull)) return yield* Effect.fail(`committed, but pulling before the push failed: ${why(pull)}`);
    const push = yield* git(repo, ["push", "-q"]);
    if (!ok(push)) return yield* Effect.fail(`committed, but the push failed: ${why(push)}`);
    return out(yield* git(repo, ["rev-parse", "--short", "HEAD"]));
  });
