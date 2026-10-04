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
 * not its target's). Its holder touches its mtime every five seconds, and a
 * lock whose mtime is ten seconds old is stale: the library's defaults, which
 * Claude keeps. `updateClaudeConfig` takes the same lock before reading, keeps
 * it fresh the same way, checks it still holds it just before renaming its
 * temporary file over the config, and removes it only if it is still its own.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// Effect's FileSystem removes with rm, which takes a directory only recursively; a lock is removed with rmdir.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { rmdir } from "node:fs/promises";

/** proper-lockfile's defaults, which Claude keeps: when a lock is stale, and how often its holder refreshes it. */
export const CLAUDE_LOCK = { staleMs: 10_000, updateMs: 5_000 } as const;

/** How long to wait for a lock another Claude holds: past its stale window, then give up. */
const LOCK_WAIT_MS = 15_000;

export type ClaudeConfig = Readonly<Record<string, unknown>>;

type Env = Readonly<Record<string, string | undefined>>;

const is = (e: PlatformError, tag: string) => e.reason._tag === tag;

/** Claude's own directory: $CLAUDE_CONFIG_DIR, or ~/.claude. Set but empty counts as set, as for Claude. */
const claudeDir = (home: string, env: Env) => env["CLAUDE_CONFIG_DIR"] ?? `${home}/.claude`;

/** Where Claude keeps its global config for this home and environment. */
export const claudeConfigPath = (home: string, env: Env) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const legacy = path.join(claudeDir(home, env), ".config.json");
    if (yield* fs.exists(legacy).pipe(Effect.orElseSucceed(() => false))) return legacy;
    const suffix = env["CLAUDE_CODE_CUSTOM_OAUTH_URL"] ? "-custom-oauth" : "";
    // Here an empty CLAUDE_CONFIG_DIR means the home directory, as `||` has it in Claude.
    return path.join(env["CLAUDE_CONFIG_DIR"] || home, `.claude${suffix}.json`);
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

/** Which lock directory is there: two readings are the same lock only with the same inode and mtime. */
interface Seen {
  readonly ino: number | undefined;
  readonly mtime: number | undefined;
}
const sameLock = (a: Seen, b: Seen) => a.ino === b.ino && a.mtime === b.mtime;

/**
 * Hold Claude's lock on `file` while `use` runs. `use` gets `whileOwned`,
 * which runs an effect (the rename that publishes a write) only after
 * checking the lock is still this one's, and fails without running it when
 * it is not. The lock's mtime is refreshed every `updateMs`; if it changes
 * under us, or a refresh comes too late, the lock is lost and `whileOwned`
 * fails from then on. Release removes the directory only while it is still
 * ours, with a plain rmdir.
 */
export const withClaudeConfigLock = <A, E, R>(
  file: string,
  use: (
    whileOwned: <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) => Effect.Effect<B, E2 | string, R2>,
  ) => Effect.Effect<A, E, R>,
  timing: { readonly staleMs: number; readonly updateMs: number } = CLAUDE_LOCK,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${file}.lock`;
    const look = fs.stat(lock).pipe(
      Effect.map((info): Seen => ({
        ino: Option.getOrUndefined(info.ino),
        mtime: Option.getOrUndefined(info.mtime)?.getTime(),
      })),
      Effect.option,
    );
    const touch = Effect.gen(function* () {
      // utimes takes seconds.
      const now = (yield* Clock.currentTimeMillis) / 1000;
      yield* fs.utimes(lock, now, now).pipe(Effect.ignore);
      return yield* look;
    });
    const removeIfStill = (seen: Seen) =>
      Effect.gen(function* () {
        const now = yield* look;
        if (Option.isSome(now) && sameLock(now.value, seen))
          yield* Effect.tryPromise(() => rmdir(lock)).pipe(Effect.ignore);
      });

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
        if (made) {
          const seen = yield* touch;
          if (Option.isSome(seen)) return seen.value;
          continue;
        }
        const now = yield* Clock.currentTimeMillis;
        const held = yield* look;
        const mtime = Option.isSome(held) ? held.value.mtime : undefined;
        if (Option.isSome(held) && mtime !== undefined && mtime + timing.staleMs < now) {
          // Its holder is gone. Like proper-lockfile, remove it and try again; only if it is
          // still that same stale lock, though between that look and the rmdir another process
          // could take it over first. proper-lockfile has that race too: this matches its
          // semantics rather than trying to beat them.
          yield* removeIfStill(held.value);
          continue;
        }
        if (now - start > LOCK_WAIT_MS)
          return yield* Effect.fail(`${lock} is held, by Claude most likely; try again`);
        const jitter = yield* Random.nextBetween(1, 2);
        yield* Effect.sleep(Duration.millis(Math.min(25 * 2 ** attempt, 1000) * jitter));
      }
    });

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const first = yield* Effect.acquireRelease(acquire, () => Effect.void);
        const mine = yield* Ref.make<Option.Option<Seen>>(Option.some(first));
        const refreshed = yield* Ref.make(yield* Clock.currentTimeMillis);
        const permit = yield* Semaphore.make(1);
        // Released last: removed only if it is still the lock this run holds.
        yield* Effect.addFinalizer(() =>
          Ref.get(mine).pipe(
            Effect.flatMap((seen) =>
              Option.isSome(seen) ? removeIfStill(seen.value) : Effect.void,
            ),
          ),
        );
        /** Ours: the lock is the one we last touched, and touched recently enough to be fresh. */
        const owned = Effect.gen(function* () {
          const seen = yield* Ref.get(mine);
          if (Option.isNone(seen)) return false;
          const now = yield* look;
          const fresh =
            (yield* Clock.currentTimeMillis) - (yield* Ref.get(refreshed)) < timing.staleMs;
          const ours = Option.isSome(now) && sameLock(now.value, seen.value) && fresh;
          if (!ours) yield* Ref.set(mine, Option.none());
          return ours;
        });
        // The heartbeat: while ours, touch it; once it is not, stop, and every write fails.
        yield* permit
          .withPermit(
            Effect.gen(function* () {
              if (!(yield* owned)) return false;
              const seen = yield* touch;
              yield* Ref.set(mine, seen);
              yield* Ref.set(refreshed, yield* Clock.currentTimeMillis);
              return Option.isSome(seen);
            }),
          )
          .pipe(
            Effect.delay(Duration.millis(timing.updateMs)),
            Effect.repeat({ while: (still) => still }),
            Effect.forkScoped,
          );
        const whileOwned = <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) =>
          permit.withPermit(
            Effect.gen(function* () {
              if (!(yield* owned))
                return yield* Effect.fail(
                  `lost the lock on ${file} to another process; nothing was written`,
                );
              return yield* effect;
            }),
          );
        return yield* use(whileOwned);
      }),
    );
  });

/** JSON the way Claude writes its config. */
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Change Claude's global config: under Claude's lock, read it fresh, apply
 * `update`, and write the result to a temporary file renamed over it (over a
 * symlink's target), keeping its mode, or 600 for a new one. With `secret`,
 * the update puts a credential in it: a config others could read becomes
 * 600, and `tightened` is the mode it had. A missing $CLAUDE_CONFIG_DIR is
 * made first, as Claude makes it. Nothing is written when any step fails,
 * or when the lock was lost before the rename.
 */
export const updateClaudeConfig = (
  home: string,
  env: Env,
  update: (config: ClaudeConfig) => ClaudeConfig,
  options: {
    readonly secret?: boolean;
    readonly timing?: { readonly staleMs: number; readonly updateMs: number };
    /** Runs after the read, before the write: for tests that slow the writer down. */
    readonly beforeWrite?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* claudeConfigPath(home, env);
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.mapError((e) => `cannot make ${path.dirname(file)}: ${e.message}`));
    // Which version of the file a write was made from: inode, size and mtime, or nothing yet.
    const stamp = (target: string) =>
      fs.stat(target).pipe(
        Effect.map((info) =>
          [
            Option.getOrUndefined(info.ino),
            Number(info.size),
            Option.getOrUndefined(info.mtime)?.getTime(),
          ].join(":"),
        ),
        Effect.orElseSucceed(() => "absent"),
      );
    return yield* withClaudeConfigLock(
      file,
      (whileOwned) =>
        Effect.gen(function* () {
          // Claude writes without the lock when it gives up waiting for it (about ten seconds).
          // So the rename also checks that the config is still the one this update was made
          // from; when it changed, the update is made again from the new one.
          for (let attempt = 0; attempt < 5; attempt++) {
            const target = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => file));
            const read = yield* stamp(target);
            const config = yield* readClaudeConfig(file);
            const had = yield* fs.stat(target).pipe(
              Effect.map((info) => info.mode & 0o777),
              Effect.orElseSucceed(() => 0o600),
            );
            const tighten = options.secret === true && (had & 0o077) !== 0;
            const mode = tighten ? 0o600 : had;
            const next = prettyJson(update(config));
            if (options.beforeWrite !== undefined) yield* options.beforeWrite;
            const temp = `${target}.t3-fleet-${yield* Random.nextIntBetween(0, 1e9)}`;
            const written = yield* Effect.gen(function* () {
              yield* fs
                .writeFileString(temp, next, { mode })
                .pipe(Effect.mapError((e) => `cannot write ${target}: ${e.message}`));
              yield* fs.chmod(temp, mode).pipe(Effect.mapError((e) => e.message));
              return yield* whileOwned(
                Effect.gen(function* () {
                  if ((yield* stamp(target)) !== read) return false;
                  yield* fs
                    .rename(temp, target)
                    .pipe(Effect.mapError((e) => `cannot write ${target}: ${e.message}`));
                  return true;
                }),
              );
            }).pipe(Effect.onError(() => fs.remove(temp).pipe(Effect.ignore)));
            if (written) return { file, tightened: tighten ? had : null };
            yield* fs.remove(temp).pipe(Effect.ignore);
          }
          return yield* Effect.fail(`${file} kept changing while T3 Fleet wrote it; try again`);
        }),
      options.timing,
    );
  });

/** At most this many backups are looked at, newest first, each up to this size, in this long. */
const BACKUPS = { count: 50, bytes: 4 * 1024 * 1024, ms: 5_000 } as const;

/**
 * The copies Claude keeps of its config, `<name>.backup.<time>`: in `backups`
 * in Claude's directory and, from older versions, beside the config itself.
 * Regular files only (a FIFO is never opened), the newest first, within
 * bounds: `incomplete` says some were left out.
 */
export const claudeConfigBackups = (home: string, env: Env) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* claudeConfigPath(home, env);
    const prefix = `${path.basename(file)}.backup.`;
    const named: Array<string> = [];
    for (const dir of [path.join(claudeDir(home, env), "backups"), path.dirname(file)])
      for (const name of yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
        if (name.startsWith(prefix)) named.push(path.join(dir, name));
    named.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
    let incomplete = named.length > BACKUPS.count;
    const files: Array<{ readonly path: string; readonly mode: number }> = [];
    for (const candidate of named.slice(0, BACKUPS.count)) {
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      // Not a regular file (a FIFO would block a read): never opened, and coverage is incomplete.
      if (info.value.type !== "File") {
        incomplete = true;
        continue;
      }
      if (Number(info.value.size) > BACKUPS.bytes) {
        incomplete = true;
        continue;
      }
      files.push({ path: candidate, mode: info.value.mode & 0o777 });
    }
    return { files, incomplete };
  });

/**
 * Whether a file holds any of `values`, reading it only if it is a regular
 * file within the size bound and only for so long; null when it could not
 * be told.
 */
export const holdsAny = (file: string, values: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (
      Option.isNone(info) ||
      info.value.type !== "File" ||
      Number(info.value.size) > BACKUPS.bytes
    )
      return null;
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.timeout(Duration.millis(BACKUPS.ms)), Effect.option);
    return Option.isNone(text) ? null : values.some((v) => text.value.includes(v));
  });
