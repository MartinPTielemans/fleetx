// Claude's config in temporary homes, written and locked as Claude does.
// @effect-diagnostics nodeBuiltinImport:off
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeConfigPath,
  exposedClaudeConfigs,
  updateClaudeConfig,
  withClaudeConfigLock,
  type ClaudeConfig,
} from "./ClaudeConfig.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
): Promise<{ readonly _tag: "Success" | "Failure" }> =>
  Effect.runPromise(effect.pipe(Effect.result, Effect.provide(NodeServices.layer)));

const addServer =
  (name: string) =>
  (config: ClaudeConfig): ClaudeConfig => ({
    ...config,
    mcpServers: { ...(config["mcpServers"] as object), [name]: { type: "stdio", command: name } },
  });

const home = (config: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "t3f-claude-config-"));
  if (config !== null) writeFileSync(join(dir, ".claude.json"), config, { mode: 0o640 });
  return dir;
};
const servers = (file: string) => Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers);

/**
 * The test clock, starting at the real time (lock mtimes stay sensible), wrapped so every sleep
 * says how long it is before it waits: a test moves time on only once a fiber waits for it.
 */
const watchedClock = Effect.gen(function* () {
  yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis));
  const clock = yield* TestClock.testClockWith(Effect.succeed);
  const sleeping = yield* Queue.unbounded<number>();
  const watched: Clock.Clock = {
    ...clock,
    sleep: (duration) =>
      Queue.offer(sleeping, Duration.toMillis(duration)).pipe(
        Effect.andThen(clock.sleep(duration)),
      ),
  };
  return { clock: watched, sleeping };
});

/** Take sleeps from `sleeping` until one `matches`. */
const waitFor = (sleeping: Queue.Dequeue<number>, matches: (ms: number) => boolean) =>
  Queue.take(sleeping).pipe(Effect.repeat({ until: matches }));

describe("Claude's global config", () => {
  it("waits for Claude's lock, and keeps what Claude wrote while holding it", async () => {
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    // Claude holds its lock: a directory beside the config, fresh.
    mkdirSync(`${file}.lock`);
    const done = Effect.runFork(
      updateClaudeConfig(dir, {}, addServer("fleet")).pipe(Effect.provide(NodeServices.layer)),
    );
    await Effect.runPromise(Effect.sleep("300 millis"));
    expect(servers(file)).toEqual([]);
    // Claude writes under its lock, then lets go.
    writeFileSync(file, '{"mcpServers":{"claudes":{"type":"stdio","command":"c"}}}');
    rmdirSync(`${file}.lock`);
    await Effect.runPromise(Fiber.join(done));
    expect(servers(file)).toEqual(["claudes", "fleet"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("takes over a lock older than proper-lockfile's stale window", async () => {
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    mkdirSync(`${file}.lock`);
    // Its holder stopped refreshing it eleven seconds ago.
    const old = statSync(`${file}.lock`).mtimeMs / 1000 - 11;
    utimesSync(`${file}.lock`, old, old);
    expect((await run(updateClaudeConfig(dir, {}, addServer("fleet"))))._tag).toBe("Success");
    expect(servers(file)).toEqual(["fleet"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("starts from nothing only when there is no config, and keeps the mode it has", async () => {
    const fresh = home(null);
    await run(updateClaudeConfig(fresh, {}, addServer("fleet")));
    expect(statSync(join(fresh, ".claude.json")).mode & 0o777).toBe(0o600);
    const kept = home('{"numStartups":3,"mcpServers":{}}');
    await run(updateClaudeConfig(kept, {}, addServer("fleet")));
    const file = join(kept, ".claude.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ numStartups: 3 });
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(kept)).toEqual([".claude.json"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails without writing, or keeping the lock, when the config cannot be read",
    async () => {
      const dir = home('{"mcpServers":{"mine":{}}}');
      const file = join(dir, ".claude.json");
      chmodSync(file, 0o000);
      expect((await run(updateClaudeConfig(dir, {}, addServer("fleet"))))._tag).toBe("Failure");
      expect(statSync(file).mode & 0o777).toBe(0o000);
      chmodSync(file, 0o600);
      expect(readFileSync(file, "utf8")).toBe('{"mcpServers":{"mine":{}}}');
      expect(existsSync(`${file}.lock`)).toBe(false);
    },
  );

  it("locks beside a symlinked config and writes through to its target", async () => {
    const dir = home(null);
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(join(dir, "dotfiles/claude.json"), '{"mcpServers":{}}', { mode: 0o600 });
    symlinkSync(join(dir, "dotfiles/claude.json"), join(dir, ".claude.json"));
    // Claude's lock is beside the link, not beside the target.
    mkdirSync(join(dir, ".claude.json.lock"));
    const done = Effect.runFork(
      updateClaudeConfig(dir, {}, addServer("fleet")).pipe(Effect.provide(NodeServices.layer)),
    );
    await Effect.runPromise(Effect.sleep("200 millis"));
    expect(servers(join(dir, "dotfiles/claude.json"))).toEqual([]);
    rmdirSync(join(dir, ".claude.json.lock"));
    await Effect.runPromise(Fiber.join(done));
    expect(lstatSync(join(dir, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(servers(join(dir, "dotfiles/claude.json"))).toEqual(["fleet"]);
  });

  // proper-lockfile's timings, scaled down: stale after 600 ms, refreshed every 200 ms.
  const quick = { staleMs: 600, updateMs: 200 } as const;

  it("keeps its lock fresh through a slow write, so another writer waits for it", async () => {
    // Virtual time: the test moves it on only once the heartbeat waits for its next beat, so how
    // fast the machine runs changes nothing.
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    await Effect.runPromise(
      Effect.gen(function* () {
        const { clock, sleeping } = yield* watchedClock;
        const release = yield* Deferred.make<void>();
        const slow = yield* updateClaudeConfig(dir, {}, addServer("fleet"), {
          timing: quick,
          beforeWrite: Deferred.await(release),
        }).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
        // Three stale windows of beats: without them, the lock would be stale three times over.
        for (let beat = 0; beat < 9; beat++) {
          yield* waitFor(sleeping, (ms) => ms === quick.updateMs);
          yield* TestClock.adjust(quick.updateMs);
        }
        // Another writer with the same rules, as Claude is: it would take over a stale lock. It
        // finds this one fresh and backs off.
        const other = yield* updateClaudeConfig(dir, {}, addServer("claudes"), {
          timing: quick,
        }).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
        yield* waitFor(sleeping, (ms) => ms !== quick.updateMs);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(slow);
        yield* TestClock.adjust("2 seconds");
        yield* Fiber.join(other);
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
    );
    expect(servers(file).sort()).toEqual(["claudes", "fleet"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("writes nothing once its lock was taken over, and leaves the new holder's lock", async () => {
    const dir = home('{"mcpServers":{"old":{}}}');
    const file = join(dir, ".claude.json");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const go = yield* Deferred.make<void>();
        // Its writer stops just before writing, while the lock is still its own.
        const slow = yield* updateClaudeConfig(dir, {}, addServer("fleet"), {
          beforeWrite: Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(go)),
          ),
        }).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(reached);
        // Someone else's lock now: the old one moved aside and a new one made, as a takeover does.
        yield* Effect.sync(() => {
          renameSync(`${file}.lock`, `${file}.lock-old`);
          mkdirSync(`${file}.lock`);
          rmdirSync(`${file}.lock-old`);
          writeFileSync(file, '{"mcpServers":{"old":{},"other":{}}}');
        });
        yield* Deferred.succeed(go, undefined);
        return yield* Fiber.join(slow);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(String(result)).toContain("another process made it anew");
    expect(servers(file)).toEqual(["old", "other"]);
    expect(existsSync(`${file}.lock`)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes("t3-fleet"))).toEqual([]);
  });

  it("makes its update again when the config changed without the lock", async () => {
    // Claude writes without the lock when it gives up waiting for it.
    const dir = home('{"mcpServers":{"old":{}}}');
    const file = join(dir, ".claude.json");
    let once = true;
    await run(
      updateClaudeConfig(dir, {}, addServer("fleet"), {
        beforeWrite: Effect.sync(() => {
          if (once) writeFileSync(file, '{"mcpServers":{"old":{},"other":{}}}');
          once = false;
        }),
      }),
    );
    expect(servers(file)).toEqual(["old", "other", "fleet"]);
  });

  it("removes its lock with a plain rmdir, never what someone put in it", async () => {
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    await run(
      updateClaudeConfig(dir, {}, addServer("fleet"), {
        beforeWrite: Effect.sync(() => writeFileSync(`${file}.lock/kept`, "")),
      }),
    );
    expect(existsSync(`${file}.lock/kept`)).toBe(true);
  });

  it("makes a missing CLAUDE_CONFIG_DIR, and takes its value as it is", async () => {
    const dir = home(null);
    const custom = join(dir, "nested/claude");
    expect(
      (await run(updateClaudeConfig(dir, { CLAUDE_CONFIG_DIR: custom }, addServer("fleet"))))._tag,
    ).toBe("Success");
    expect(servers(join(custom, ".claude.json"))).toEqual(["fleet"]);
    const spaced = join(dir, " spaced ");
    await run(updateClaudeConfig(dir, { CLAUDE_CONFIG_DIR: spaced }, addServer("fleet")));
    expect(existsSync(join(spaced, ".claude.json"))).toBe(true);
  });

  it("finds the config where Claude does", async () => {
    const path = (dir: string, env: Record<string, string>) =>
      Effect.runPromise(claudeConfigPath(dir, env).pipe(Effect.provide(NodeServices.layer)));
    const dir = home(null);
    expect(await path(dir, {})).toBe(join(dir, ".claude.json"));
    expect(await path(dir, { CLAUDE_CONFIG_DIR: join(dir, "c") })).toBe(
      join(dir, "c", ".claude.json"),
    );
    expect(await path(dir, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://x" })).toBe(
      join(dir, ".claude-custom-oauth.json"),
    );
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/.config.json"), "{}");
    expect(await path(dir, {})).toBe(join(dir, ".claude/.config.json"));
  });
});

/** Run `effect` with the real file system but for what `patch` replaces: faults injected. */
const patched = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  patch: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* effect.pipe(
      Effect.provideService(FileSystem.FileSystem, { ...fs, ...patch(fs) }),
    );
  });

describe("Claude's lock, with faults injected", () => {
  const timing = { staleMs: 600, updateMs: 50 } as const;

  /** A lock taken with `utimes` refused (EPERM) from its `from`th call on: the error it ends with. */
  const refused = (file: string, from: number) => {
    let touches = 0;
    return Effect.runPromise(
      patched(
        withClaudeConfigLock(file, () => Effect.void, timing),
        (fs) => ({
          utimes: (path, atime, mtime) =>
            ++touches < from
              ? fs.utimes(path, atime, mtime)
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "utime",
                    pathOrDescriptor: path,
                  }),
                ),
        }),
      ).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );
  };

  it("removes the lock it made, and says why, when the precision probe fails", async () => {
    const dir = home("{}");
    const error = await refused(join(dir, ".claude.json"), 1);
    expect(String(error)).toContain("PermissionDenied");
    expect(existsSync(join(dir, ".claude.json.lock"))).toBe(false);
  });

  it("removes the lock it made, and says why, when its first mtime cannot be written", async () => {
    const dir = home("{}");
    const error = await refused(join(dir, ".claude.json"), 2);
    expect(String(error)).toContain("PermissionDenied");
    expect(String(error)).not.toContain("another process");
    expect(existsSync(join(dir, ".claude.json.lock"))).toBe(false);
  });
  const locked = (file: string, wait: number, published: { value: boolean }) =>
    withClaudeConfigLock(
      file,
      (whileOwned) =>
        Effect.sleep(Duration.millis(wait)).pipe(
          Effect.andThen(whileOwned(Effect.sync(() => void (published.value = true)))),
        ),
      timing,
    );

  /**
   * Holds the lock until `fault` has run inside the first heartbeat's utimes (acquiring makes the
   * first two: the precision probe, then our mtime), then tries to publish: the error it ends with.
   * The stale window is far off, so only the fault can lose the lock.
   */
  const faulted = (file: string, fault: (lock: string) => void, after: boolean) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const injected = yield* Deferred.make<void>();
        let touches = 0;
        const inject = Effect.sync(() => fault(`${file}.lock`)).pipe(
          Effect.andThen(Deferred.succeed(injected, undefined)),
        );
        return yield* patched(
          withClaudeConfigLock(
            file,
            (whileOwned) => Deferred.await(injected).pipe(Effect.andThen(whileOwned(Effect.void))),
            { staleMs: 60_000, updateMs: 20 },
          ),
          (fs) => ({
            utimes: (path, atime, mtime) =>
              Effect.suspend(() => {
                if (++touches !== 3) return fs.utimes(path, atime, mtime);
                return after
                  ? fs.utimes(path, atime, mtime).pipe(Effect.andThen(inject))
                  : inject.pipe(Effect.andThen(fs.utimes(path, atime, mtime)));
              }),
          }),
        ).pipe(Effect.flip);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  it("loses the lock when another process makes it anew between check and refresh", async () => {
    const dir = home("{}");
    const lock = join(dir, ".claude.json.lock");
    const error = await faulted(
      join(dir, ".claude.json"),
      (lock) => {
        // Moved aside before its replacement is made, so the inode cannot be reused anywhere.
        renameSync(lock, `${lock}-old`);
        mkdirSync(lock);
        rmdirSync(`${lock}-old`);
      },
      false,
    );
    expect(String(error)).toContain("another process made it anew");
    // The other process's lock stays.
    expect(existsSync(lock)).toBe(true);
  });

  it("loses the lock when another process sets its mtime between refresh and look", async () => {
    const dir = home("{}");
    const lock = join(dir, ".claude.json.lock");
    const error = await faulted(
      join(dir, ".claude.json"),
      (lock) => {
        const now = statSync(lock);
        utimesSync(lock, now.atime, (now.mtimeMs + 300) / 1000);
      },
      true,
    );
    expect(String(error)).toContain("another process touched it");
    expect(existsSync(lock)).toBe(true);
  });

  it("loses the lock when a refresh fails, and never publishes on a stale one", async () => {
    const dir = home("{}");
    const published = { value: false };
    let touches = 0;
    const result = await run(
      patched(locked(join(dir, ".claude.json"), 1500, published), (fs) => ({
        utimes: (path, atime, mtime) =>
          ++touches === 1 ? fs.utimes(path, atime, mtime) : fs.utimes(`${path}-gone`, atime, mtime),
      })),
    );
    expect(result._tag).toBe("Failure");
    expect(published.value).toBe(false);
  });

  it("counts a late refresh from when it began", async () => {
    const dir = home("{}");
    const published = { value: false };
    let touches = 0;
    const result = await run(
      patched(locked(join(dir, ".claude.json"), 850, published), (fs) => ({
        utimes: (path, atime, mtime) =>
          ++touches === 1
            ? fs.utimes(path, atime, mtime)
            : fs.utimes(path, atime, mtime).pipe(Effect.delay("800 millis")),
      })),
    );
    expect(result._tag).toBe("Failure");
    expect(published.value).toBe(false);
  });

  it("gives up on a stale lock it cannot remove, in time and saying so", async () => {
    const dir = home("{}");
    const lock = join(dir, ".claude.json.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "kept"), "");
    const old = statSync(lock).mtimeMs / 1000 - 20;
    utimesSync(lock, old, old);
    const error = await Effect.runPromise(
      updateClaudeConfig(dir, {}, addServer("fleet"), {
        timing: { staleMs: 600, updateMs: 200, waitMs: 500 },
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer), Effect.timeout("5 seconds")),
    );
    expect(String(error)).toContain("cannot be removed");
    expect(existsSync(join(lock, "kept"))).toBe(true);
  });
});

describe("Claude's config, changed while it was being written", () => {
  it("compares what it read, not the file's size and time", async () => {
    const dir = home('{"mcpServers":{"old":{}}}');
    const file = join(dir, ".claude.json");
    const ms = Math.floor(statSync(file).mtimeMs);
    utimesSync(file, ms / 1000, (ms + 0.2) / 1000);
    let once = true;
    await run(
      updateClaudeConfig(dir, {}, addServer("fleet"), {
        beforeWrite: Effect.sync(() => {
          if (!once) return;
          once = false;
          // Rewritten in place: same inode, same size, within the same millisecond.
          writeFileSync(file, '{"mcpServers":{"new":{}}}');
          utimesSync(file, ms / 1000, (ms + 0.8) / 1000);
        }),
      }),
    );
    expect(servers(file)).toEqual(["new", "fleet"]);
  });

  it("stops starting over once its time is up", async () => {
    // Virtual time, moved on 200 ms by each attempt: the second starts at 200 (within 300), a
    // third would start at 400, however slowly the machine runs.
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    let calls = 0;
    const result = await Effect.runPromise(
      updateClaudeConfig(dir, {}, addServer("fleet"), {
        retryMs: 300,
        beforeWrite: TestClock.adjust("200 millis").pipe(
          Effect.andThen(
            Effect.sync(() => writeFileSync(file, `{"mcpServers":{"c${++calls}":{}}}`)),
          ),
        ),
      }).pipe(Effect.result, Effect.provide(TestClock.layer()), Effect.provide(NodeServices.layer)),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toBe(2);
  });
});

describe("Claude's config backups, looked into within bounds", () => {
  const exposed = (dir: string) =>
    Effect.runPromise(
      exposedClaudeConfigs(dir, {}, ["s3cret"], 200).pipe(Effect.provide(NodeServices.layer)),
    );

  it("counts listing and stat against the one deadline", async () => {
    const dir = home(null);
    mkdirSync(join(dir, ".claude/backups"), { recursive: true });
    const result = await Effect.runPromise(
      patched(exposedClaudeConfigs(dir, {}, ["s3cret"], 200), (fs) => ({
        readDirectory: (path, options) =>
          fs.readDirectory(path, options).pipe(Effect.delay("1 second")),
      })).pipe(Effect.provide(NodeServices.layer), Effect.timeout("3 seconds")),
    );
    expect(result).toEqual({ exposed: [], incomplete: true });
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports a backups directory it cannot read, and not one that is absent",
    async () => {
      const dir = home(null);
      expect(await exposed(dir)).toEqual({ exposed: [], incomplete: false });
      mkdirSync(join(dir, ".claude/backups"), { recursive: true });
      chmodSync(join(dir, ".claude/backups"), 0o000);
      expect((await exposed(dir)).incomplete).toBe(true);
      chmodSync(join(dir, ".claude/backups"), 0o700);
    },
  );
});
