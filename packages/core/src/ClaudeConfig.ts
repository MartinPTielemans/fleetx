/**
 * Claude Code's global config, ~/.claude.json: where Claude keeps it, and
 * changing it the way Claude does, so neither loses the other's writes.
 *
 * Claude reads ~/.claude/.config.json when that legacy file exists, and
 * otherwise `.claude.json` in $CLAUDE_CONFIG_DIR, or in the home directory
 * (`.claude-custom-oauth.json` with CLAUDE_CODE_CUSTOM_OAUTH_URL set).
 *
 * Claude changes it under a proper-lockfile lock: the directory
 * `<config>.lock`, made with mkdir beside the config's own path (a symlink's,
 * not its target's), and stale once its mtime is ten seconds old, the
 * library's default that Claude keeps (it refreshes the mtime every five
 * seconds while it holds the lock). `updateClaudeConfig` takes the same lock
 * before reading, holds it through writing a temporary file and renaming it
 * over the config, keeping its mode, and always removes it.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

/** proper-lockfile's `stale`, which Claude leaves at its default. */
export const CLAUDE_LOCK_STALE_MS = 10_000;

/** How long to wait for a lock another Claude holds: past its stale window, then give up. */
const LOCK_WAIT_MS = 15_000;

export type ClaudeConfig = Readonly<Record<string, unknown>>;

const is = (e: PlatformError, tag: string) => e.reason._tag === tag;

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

/**
 * The config at `file`: `{}` when there is none yet. Any other failure to
 * read it, or a file that is not a JSON object, fails: never a reason to
 * start over.
 */
export const readClaudeConfig = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchIf(
        (e) => is(e, "NotFound"),
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((e) => `cannot read ${file}: ${e.message}`),
    );
    if (Option.isNone(text)) return {} as ClaudeConfig;
    const parsed = Option.getOrUndefined(
      Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text.value),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return yield* Effect.fail(`${file} is not a JSON object; leaving it as it is`);
    return parsed as ClaudeConfig;
  });

/** Hold Claude's lock on `file` around `use`; it is removed however `use` ends. */
export const withClaudeConfigLock = <A, E, R>(file: string, use: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${file}.lock`;
    const acquire = Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      for (let attempt = 0; ; attempt++) {
        const made = yield* fs.makeDirectory(lock).pipe(
          Effect.as(true),
          Effect.catchIf(
            (e) => is(e, "AlreadyExists"),
            () => Effect.succeed(false),
          ),
          Effect.mapError((e) => `cannot lock ${file}: ${e.message}`),
        );
        if (made) return;
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
        const jitter = yield* Random.nextBetween(1, 2);
        yield* Effect.sleep(Duration.millis(Math.min(25 * 2 ** attempt, 1000) * jitter));
      }
    });
    return yield* Effect.acquireUseRelease(
      acquire,
      () => use,
      () => fs.remove(lock, { recursive: true }).pipe(Effect.ignore),
    );
  });

/** JSON the way Claude writes its config. */
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Change Claude's global config: under Claude's lock, read it fresh, apply
 * `update`, and write the result to a temporary file renamed over it (over a
 * symlink's target), keeping its mode, or 600 for a new one. With `secret`,
 * the update puts a credential in it: a config others could read becomes
 * 600, and `tightened` is the mode it had. Nothing is written when any step
 * fails.
 */
export const updateClaudeConfig = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  update: (config: ClaudeConfig) => ClaudeConfig,
  options: { readonly secret?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* claudeConfigPath(home, env);
    return yield* withClaudeConfigLock(
      file,
      Effect.gen(function* () {
        const config = yield* readClaudeConfig(file);
        const target = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
        const had = yield* fs.stat(target).pipe(
          Effect.map((info) => info.mode & 0o777),
          Effect.orElseSucceed(() => 0o600),
        );
        const tighten = options.secret === true && (had & 0o077) !== 0;
        const mode = tighten ? 0o600 : had;
        const temp = `${target}.t3-fleet-${yield* Random.nextIntBetween(0, 1e9)}`;
        yield* Effect.gen(function* () {
          yield* fs.writeFileString(temp, prettyJson(update(config)), { mode });
          yield* fs.chmod(temp, mode);
          yield* fs.rename(temp, target);
        }).pipe(
          Effect.mapError((e) => `cannot write ${target}: ${e.message}`),
          Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)),
        );
        return { file, tightened: tighten ? had : null };
      }),
    );
  });

/**
 * The copies Claude keeps of its config, `<name>.backup.<time>`: in `backups`
 * under $CLAUDE_CONFIG_DIR (or ~/.claude), and, from older versions, beside
 * the config itself.
 */
export const claudeConfigBackups = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* claudeConfigPath(home, env);
    const prefix = `${path.basename(file)}.backup.`;
    const dirs = [
      path.join(env["CLAUDE_CONFIG_DIR"]?.trim() || path.join(home, ".claude"), "backups"),
      path.dirname(file),
    ];
    const found: Array<string> = [];
    for (const dir of dirs)
      for (const name of yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
        if (name.startsWith(prefix)) found.push(path.join(dir, name));
    return found.sort();
  });
