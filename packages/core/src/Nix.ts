/**
 * What Nix installed. Nix keeps those copies' versions, so T3 Fleet reports on
 * them but never installs or updates over them. A profile (~/.nix-profile,
 * /etc/profiles/per-user, /run/current-system/sw) only links into the store,
 * so every check resolves the path first.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { t3CliFromCommandLine } from "./T3Access.ts";

/** Whether `file` is, or links to, something in the Nix store (`store` is for tests). */
export const inNixStore = (file: string, store = "/nix/store/") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
    return real.startsWith(store);
  });

/**
 * The program a T3 server command line runs: the script when node or bun runs
 * it, wherever they come from. Null for T3's own runtime and the desktop app,
 * which update themselves.
 */
export const t3Program = (commandLine: string): string | null => {
  if (t3CliFromCommandLine(commandLine) !== null) return null;
  const [program = "", script = ""] = commandLine.trim().split(/\s+/);
  const t3 = /(?:^|\/)(?:node|bun)$/.test(program) ? script : program;
  return t3.startsWith("/") ? t3 : null;
};

/** Whether the T3 server on this command line comes from Nix, so Nix, not T3, updates it. */
export const t3FromNix = (commandLine: string, store?: string) => {
  const program = t3Program(commandLine);
  return program === null ? Effect.succeed(false) : inNixStore(program, store);
};
