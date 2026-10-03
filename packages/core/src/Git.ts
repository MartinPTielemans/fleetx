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

export const gitEnv = (home: string, env: Readonly<Record<string, string | undefined>>) => ({
  ...env,
  GIT_CONFIG_GLOBAL: gitConfigPath(home),
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
});

export const git = (dir: string, args: ReadonlyArray<string>, options: { readonly stdin?: string; readonly timeout?: Duration.Input } = {}) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    return yield* exec({
      command: "git",
      args: ["-C", dir, ...args],
      env: gitEnv(home, process.env),
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
