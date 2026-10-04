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
import * as Result from "effect/Result";
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

/** The config's text as it is now: none when there is no config yet; any other failure fails. */
const readConfigText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchIf(
        (e) => is(e, "NotFound"),
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((e) => `cannot read ${file}: ${e.message}`),
    );
  });

/** A config's text as a JSON object, `{}` for none; anything else fails. */
const parseConfig = (file: string, text: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(text)) return {} as ClaudeConfig;
    const parsed = Option.getOrUndefined(
      Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text.value),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return yield* Effect.fail(`${file} is not a JSON object; leaving it as it is`);
    return parsed as ClaudeConfig;
  });

/**
 * The config at `file`: `{}` when there is none yet. Any other failure to
 * read it, or a file that is not a JSON object, fails: never a reason to
 * start over.
 */
export const readClaudeConfig = (file: string) =>
  readConfigText(file).pipe(Effect.flatMap((text) => parseConfig(file, text)));

/**
 * Which lock directory is there. Its identity is its inode and, where the
 * platform reports one, its birthtime (statx on Linux): ext4 and overlayfs
 * often give a directory removed and made again at once the same inode, so
 * the inode alone would not tell them apart. Two readings are the same lock
 * only with the same identity and mtime.
 */
interface Seen {
  readonly id: string;
  readonly ino: number | undefined;
  readonly mtime: number | undefined;
}
const sameLock = (a: Seen, b: Seen) => a.id === b.id && a.mtime === b.mtime;

/** How finely the lock's filesystem keeps mtimes: whole seconds, or milliseconds. */
type Precision = "s" | "ms";

/** The mtime to give the lock, as proper-lockfile's getMtime: seconds rounded up, or milliseconds. */
const mtimeFor = (now: number, precision: Precision) =>
  precision === "s" ? Math.ceil(now / 1000) * 1000 : Math.floor(now);

/**
 * The seconds to hand utimes for an mtime. A millisecond one is written at the
 * middle of its millisecond: seconds as a float can land a hair before it, and
 * a stat that truncates to a Date would then read the millisecond before.
 */
const utimesSeconds = (mtime: number, precision: Precision) =>
  (precision === "s" ? mtime : mtime + 0.5) / 1000;

/** An mtime as read back, at the precision it was written with. */
const atPrecision = (mtime: number, precision: Precision) =>
  precision === "s" ? Math.floor(mtime / 1000) * 1000 : Math.floor(mtime);

export interface LockTiming {
  readonly staleMs: number;
  readonly updateMs: number;
  /** How long to wait for another holder before giving up; LOCK_WAIT_MS by default. */
  readonly waitMs?: number;
}

/**
 * Hold Claude's lock on `file` while `use` runs, with proper-lockfile's
 * guarantees (Claude's writer has no stronger ones).
 *
 * `use` gets `whileOwned`, which runs an effect (the rename that publishes a
 * write) only after checking, under the same permit the heartbeat takes, that
 * the lock is still ours: the directory this run made (its identity), with the
 * mtime this run last gave it, given less than `staleMs` ago. The heartbeat
 * refreshes it every `updateMs`: it checks the lock, sets an explicit mtime,
 * and looks again. As in proper-lockfile, the filesystem's mtime precision
 * (seconds or milliseconds) is probed once, the mtime written is truncated to
 * it and kept as the one expected, and every later look (after the refresh, on
 * the next heartbeat, before publishing, before release) must find exactly
 * that: a mtime set by anyone else means the lock is compromised. A failed
 * refresh, a refresh that finds another directory or another mtime, or one
 * that comes too late loses the lock for good, and every write fails from then
 * on; freshness only ever comes from a refresh that worked. Release rmdirs the
 * directory only while it is still ours.
 *
 * Windows that remain, as in proper-lockfile: a takeover between our check
 * and our utimes gets its mtime touched once. We see it, and stop, when the
 * new directory has a new inode or a new birthtime; where it has neither (a
 * reused inode on a filesystem that reports no birthtime), that replacement
 * goes unnoticed. And between whileOwned's check and the rename another
 * process may take a lock it believes stale. None of these can be closed
 * with a directory lock, and proper-lockfile has them all.
 */
export const withClaudeConfigLock = <A, E, R>(
  file: string,
  use: (
    whileOwned: <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) => Effect.Effect<B, E2 | string, R2>,
  ) => Effect.Effect<A, E, R>,
  timing: LockTiming = CLAUDE_LOCK,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = `${file}.lock`;
    const waitMs = timing.waitMs ?? LOCK_WAIT_MS;
    const look = fs.stat(lock).pipe(
      Effect.map((info): Seen => ({
        id: [
          Option.getOrUndefined(info.ino),
          // No birthtime, or none worth having (0): the inode alone.
          Option.getOrUndefined(Option.filter(info.birthtime, (b) => b.getTime() > 0))?.getTime(),
        ].join(":"),
        ino: Option.getOrUndefined(info.ino),
        mtime: Option.getOrUndefined(info.mtime)?.getTime(),
      })),
    );
    /** Remove the lock if it is still the one `still` accepts; whether it is gone. */
    const removeIfStill = (still: (now: Seen) => boolean) =>
      Effect.gen(function* () {
        const now = yield* look.pipe(Effect.option);
        if (Option.isNone(now)) return true;
        if (!still(now.value)) return false;
        return yield* Effect.tryPromise(() => rmdir(lock)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
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
          // Ours. Probe the mtime precision as proper-lockfile does: an mtime 5 ms past a whole
          // second reads back whole only where seconds are all the filesystem keeps (utimes takes
          // seconds). Then give it our mtime, remember it, and its identity.
          const touch = (seconds: number) =>
            fs.utimes(lock, seconds, seconds).pipe(Effect.mapError((e) => e.message));
          // The directory we made, and every mtime we saw on it: if this fails, the directory goes
          // again while it is still that one, untouched by anyone else, so Claude need not wait
          // out its stale window.
          let created: Seen | undefined;
          const known = new Set<number | undefined>();
          const probed = yield* Effect.gen(function* () {
            created = yield* look.pipe(Effect.mapError((e) => e.message));
            known.add(created.mtime);
            yield* touch(
              utimesSeconds(Math.ceil((yield* Clock.currentTimeMillis) / 1000) * 1000 + 5, "ms"),
            );
            const seen = yield* look.pipe(Effect.mapError((e) => e.message));
            known.add(seen.mtime);
            const precision: Precision = (seen.mtime ?? 0) % 1000 === 0 ? "s" : "ms";
            const at = yield* Clock.currentTimeMillis;
            const mtime = mtimeFor(at, precision);
            yield* touch(utimesSeconds(mtime, precision));
            // Its identity is taken after this first mtime: APFS moves a directory's birthtime back
            // to an mtime set before it, and the clock can read just before the moment it was made.
            // Later refreshes are later, so it stays.
            const after = yield* look.pipe(Effect.mapError((e) => e.message));
            return after.ino === seen.ino &&
              after.mtime !== undefined &&
              atPrecision(after.mtime, precision) === mtime
              ? Option.some({ id: after.id, mtime, at, precision })
              : Option.none();
          }).pipe(Effect.result);
          if (Result.isSuccess(probed) && Option.isSome(probed.success))
            return probed.success.value;
          const ours = created;
          if (ours !== undefined)
            yield* removeIfStill((now) => now.ino === ours.ino && known.has(now.mtime));
          return yield* Effect.fail(
            Result.isFailure(probed)
              ? `cannot lock ${file}: ${probed.failure}`
              : `${lock} was changed by another process as it was made; try again`,
          );
        }
        const now = yield* Clock.currentTimeMillis;
        const held = yield* look.pipe(Effect.option);
        let why = "held, by Claude most likely; try again";
        if (Option.isSome(held)) {
          const mtime = held.value.mtime;
          if (mtime !== undefined && mtime + timing.staleMs < now) {
            // Its holder is gone. Like proper-lockfile, remove it and try again; only if it is
            // still that same stale lock, though between that look and the rmdir another process
            // could take it over first. proper-lockfile has that race too: this matches its
            // semantics rather than trying to beat them.
            const stale = held.value;
            if (yield* removeIfStill((now) => sameLock(now, stale))) {
              if (now - start > waitMs) break;
              continue;
            }
            why =
              "stale, but cannot be removed (something is in it); remove it by hand while no Claude runs";
          }
        }
        if (now - start > waitMs) return yield* Effect.fail(`${lock} is ${why}`);
        const jitter = yield* Random.nextBetween(1, 2);
        yield* Effect.sleep(Duration.millis(Math.min(25 * 2 ** attempt, 1000) * jitter));
      }
      return yield* Effect.fail(`${lock} kept being taken; try again`);
    });

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const first = yield* acquire;
        const { id: identity, precision } = first;
        /** The mtime our last refresh wrote (the one expected), and when it was written. */
        const mine = yield* Ref.make({ mtime: first.mtime, at: first.at });
        const ours = (now: Seen, mtime: number) =>
          now.id === identity &&
          now.mtime !== undefined &&
          atPrecision(now.mtime, precision) === mtime;
        const lost = yield* Ref.make<string | null>(null);
        const permit = yield* Semaphore.make(1);
        const lose = (why: string) => Ref.set(lost, why).pipe(Effect.as(false));
        // Released last: removed only if it is still the directory this run made, as we left it.
        yield* Effect.addFinalizer(() =>
          Ref.get(mine).pipe(
            Effect.flatMap(({ mtime }) => removeIfStill((now) => ours(now, mtime))),
            Effect.ignore,
          ),
        );
        /** Why the lock is no longer ours, or null while it is. */
        const check = Effect.gen(function* () {
          const already = yield* Ref.get(lost);
          if (already !== null) return already;
          const now = yield* look.pipe(Effect.option);
          const { mtime, at } = yield* Ref.get(mine);
          if (Option.isNone(now)) return "it was removed";
          if (now.value.id !== identity) return "another process made it anew";
          if (!ours(now.value, mtime)) return "another process touched it";
          if ((yield* Clock.currentTimeMillis) - at >= timing.staleMs)
            return "it was not refreshed in time";
          return null;
        });
        const refresh = Effect.gen(function* () {
          const why = yield* check;
          if (why !== null) return yield* lose(why);
          const at = yield* Clock.currentTimeMillis;
          const mtime = mtimeFor(at, precision);
          const seconds = utimesSeconds(mtime, precision);
          const touched = yield* fs.utimes(lock, seconds, seconds).pipe(
            Effect.as(null),
            Effect.catch((e) => Effect.succeed(`refreshing it failed: ${e.message}`)),
          );
          if (touched !== null) return yield* lose(touched);
          const after = yield* look.pipe(Effect.option);
          if (Option.isNone(after) || after.value.id !== identity)
            return yield* lose("another process made it anew");
          // What it finds must be the mtime it wrote: never adopt one someone else set.
          if (!ours(after.value, mtime)) return yield* lose("another process touched it");
          // A late refresh still counts from when it began: that is the mtime it set.
          yield* Ref.set(mine, { mtime, at });
          return true;
        });
        // The heartbeat: while ours, refresh it; once it is not, stop, and every write fails.
        yield* permit
          .withPermit(refresh)
          .pipe(
            Effect.delay(Duration.millis(timing.updateMs)),
            Effect.repeat({ while: (still) => still }),
            Effect.forkScoped,
          );
        const whileOwned = <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) =>
          permit.withPermit(
            Effect.gen(function* () {
              const why = yield* check;
              if (why !== null) {
                yield* Ref.set(lost, why);
                return yield* Effect.fail(`lost the lock on ${file} (${why}); nothing was written`);
              }
              return yield* effect;
            }),
          );
        return yield* use(whileOwned);
      }),
    );
  });

/** JSON the way Claude writes its config. */
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** How long an update may keep starting over because the config kept changing. */
const RETRY_MS = 30_000;

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
    readonly timing?: LockTiming;
    /** How long to keep starting over; RETRY_MS by default. */
    readonly retryMs?: number;
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
    const same = (a: Option.Option<string>, b: Option.Option<string>) =>
      Option.isNone(a) ? Option.isNone(b) : Option.isSome(b) && a.value === b.value;
    return yield* withClaudeConfigLock(
      file,
      (whileOwned) =>
        Effect.gen(function* () {
          // Claude writes without the lock when it gives up waiting for it (after ten seconds or
          // so). So just before the rename the config is read again and must be exactly the text
          // this update was made from; when it changed, the update is made again from the new
          // one. That narrows the window to the rename itself: it is no atomic compare-and-swap,
          // and nothing over a lock directory can be.
          const start = yield* Clock.currentTimeMillis;
          for (let attempt = 0; attempt < 5; attempt++) {
            if (
              attempt > 0 &&
              (yield* Clock.currentTimeMillis) - start > (options.retryMs ?? RETRY_MS)
            )
              break;
            // A link is written through to its target; a link to nothing is refused, never replaced by a file.
            const target = yield* fs.realPath(file).pipe(
              Effect.catch(() =>
                fs.readLink(file).pipe(
                  Effect.matchEffect({
                    onFailure: () => Effect.succeed(file),
                    onSuccess: (to) =>
                      Effect.fail(
                        `${file} is a link to ${to}, which is missing; leaving it as it is`,
                      ),
                  }),
                ),
              ),
            );
            const read = yield* readConfigText(file);
            const config = yield* parseConfig(file, read);
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
                  if (!same(yield* readConfigText(file), read)) return false;
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

/** The scan's bounds: backups looked at, newest first; the size of one; the time for all. */
const SCAN = { count: 50, bytes: 4 * 1024 * 1024, ms: 10_000 } as const;

/**
 * Claude's config and the copies Claude keeps of it (`<name>.backup.<time>`, in
 * `backups` in Claude's directory and, from older versions, beside the config)
 * that others can read and that hold any of `values`. Only regular files are
 * read (a FIFO never is), within SCAN's bounds, under one deadline for the
 * whole scan, listing and stats included. `incomplete` says something could
 * not be looked into: too many, too large, not a regular file, unreadable
 * (absent is not), or out of time.
 */
export const exposedClaudeConfigs = (
  home: string,
  env: Env,
  values: ReadonlyArray<string>,
  deadlineMs: number = SCAN.ms,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exposed: Array<string> = [];
    let incomplete = false;
    const scan = Effect.gen(function* () {
      const file = yield* claudeConfigPath(home, env);
      const prefix = `${path.basename(file)}.backup.`;
      const backups: Array<string> = [];
      for (const dir of [path.join(claudeDir(home, env), "backups"), path.dirname(file)]) {
        const names = yield* fs.readDirectory(dir).pipe(
          Effect.catchIf(
            (e) => is(e, "NotFound"),
            () => Effect.succeed([] as Array<string>),
          ),
          Effect.catch(() => {
            incomplete = true;
            return Effect.succeed([] as Array<string>);
          }),
        );
        for (const name of names) if (name.startsWith(prefix)) backups.push(path.join(dir, name));
      }
      backups.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
      if (backups.length > SCAN.count) incomplete = true;
      for (const candidate of [file, ...backups.slice(0, SCAN.count)]) {
        const info = yield* fs.stat(candidate).pipe(
          Effect.asSome,
          Effect.catchIf(
            (e) => is(e, "NotFound"),
            () => Effect.succeed(Option.none()),
          ),
          Effect.catch(() => {
            incomplete = true;
            return Effect.succeed(Option.none());
          }),
        );
        if (Option.isNone(info)) continue;
        if ((info.value.mode & 0o077) === 0) continue;
        if (info.value.type !== "File" || Number(info.value.size) > SCAN.bytes) {
          incomplete = true;
          continue;
        }
        const text = yield* fs.readFileString(candidate).pipe(Effect.option);
        if (Option.isNone(text)) incomplete = true;
        else if (values.some((v) => text.value.includes(v))) exposed.push(candidate);
      }
    });
    if (Option.isNone(yield* scan.pipe(Effect.timeout(Duration.millis(deadlineMs)), Effect.option)))
      incomplete = true;
    return { exposed, incomplete };
  });
