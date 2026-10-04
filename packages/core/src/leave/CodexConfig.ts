/**
 * Writing Claude's and Codex's own config files, without losing a write
 * either makes meanwhile.
 *
 * Claude changes ~/.claude.json under a proper-lockfile lock: the directory
 * `<config>.lock`, made with mkdir beside the config's own path, stale once
 * its mtime is ten seconds old. `updateClaudeConfig` takes the same lock from
 * the read through the rename. It has the shape of ClaudeConfig.ts's in the
 * MCP credentials work, which replaces it once that lands.
 *
 * Codex takes no lock: it reads config.toml, edits it, and writes it whole
 * with a temporary file renamed over it. `updateCodexConfig` does the same
 * and checks, right before its rename, that the file is still what it read,
 * so a write of Codex's is lost only if it lands in the instant between that
 * check and the rename.
 *
 * Either refuses a config that is a link to nothing, rather than replace the
 * link with a file.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { editFile, isObject, prettyJson, writeAtomically } from "./Files.ts";

type Json = Record<string, unknown>;

/** proper-lockfile's `stale`, which Claude leaves at its default. */
export const CLAUDE_LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const errorText = (e: unknown) =>
  typeof e === "string"
    ? e
    : isObject(e) && typeof e["message"] === "string"
      ? e["message"]
      : String(e);

/** Where Claude keeps its global config for this home and environment. */
export const claudeConfigPath = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = env["CLAUDE_CONFIG_DIR"]?.trim() || undefined;
    const legacy = path.join(dir ?? path.join(home, ".claude"), ".config.json");
    if (yield* fs.exists(legacy).pipe(Effect.orElseSucceed(() => false))) return legacy;
    const suffix = env["CLAUDE_CODE_CUSTOM_OAUTH_URL"] ? "-custom-oauth" : "";
    return path.join(dir ?? home, `.claude${suffix}.json`);
  });

/** Hold Claude's lock on `file` around `use`; it is removed however `use` ends. */
export const withClaudeConfigLock = <A, E, R>(file: string, use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${file}.lock`;
    const acquire = Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      for (let attempt = 0; ; attempt++) {
        if (
          yield* fs.makeDirectory(lock).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        )
          return;
        const now = yield* Clock.currentTimeMillis;
        const held = yield* fs.stat(lock).pipe(Effect.option);
        const mtime = Option.isSome(held) ? Option.getOrUndefined(held.value.mtime) : undefined;
        if (mtime !== undefined && mtime.getTime() + CLAUDE_LOCK_STALE_MS < now) {
          // Its holder is gone: proper-lockfile removes a stale lock and takes it.
          yield* fs.remove(lock, { recursive: true }).pipe(Effect.ignore);
          continue;
        }
        if (now - start > LOCK_WAIT_MS)
          return yield* Effect.fail(`${lock} is held, by Claude most likely; try again`);
        yield* Effect.sleep(Duration.millis(Math.min(25 * 2 ** attempt, 1000)));
      }
    });
    return yield* Effect.acquireUseRelease(
      acquire,
      () => use,
      () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
    );
  });

/**
 * Change Claude's global config under Claude's lock: read it fresh, apply
 * `update`, and write it back (temporary file, rename), keeping its mode, or
 * 600 for a new one. Nothing is written when `update` changes nothing, or
 * when any step fails. Returns whether it wrote.
 */
export const updateClaudeConfig = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  update: (config: Json) => Json,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* claudeConfigPath(home, env);
    return yield* withClaudeConfigLock(
      file,
      Effect.gen(function* () {
        const text = Option.getOrNull(yield* fs.readFileString(file).pipe(Effect.option));
        const parsed = text === null ? Option.some({} as unknown) : decodeJson(text);
        if (Option.isNone(parsed) || !isObject(parsed.value))
          return yield* Effect.fail(`${file} is not a JSON object; it was left as it is`);
        const next = update(parsed.value);
        const out = `${prettyJson(next)}${text === null || text.endsWith("\n") ? "\n" : ""}`;
        if (text !== null && prettyJson(parsed.value) === prettyJson(next)) return false;
        yield* writeAtomically(file, out, text, { mode: 0o600 });
        return true;
      }),
    );
  }).pipe(Effect.mapError(errorText));

/** Change Codex's config.toml: `edit` gets its text (null: none) and returns the new text, or null for no change. */
export const updateCodexConfig = <E, R>(
  home: string,
  edit: (text: string | null) => Effect.Effect<string | null, E, R>,
) => editFile(`${home}/.codex/config.toml`, edit, { mode: 0o600 });
