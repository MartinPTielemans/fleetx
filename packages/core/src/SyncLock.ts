/**
 * One writer to the config repo's checkout at a time on this machine: a sync
 * run, or a command changing the repo (approve, skills, secrets, invite…).
 *
 * The lock is a directory, created atomically, holding its owner: pid, start
 * and a token. It goes stale only when that process has gone, never after a
 * while: a laptop can sleep for hours in the middle of a sync and carry on.
 * Gone means dead, or its pid now someone else's: the machine booted since
 * (a power loss), or the process at that pid is not the one that took it.
 * Both are told by what the kernel keeps, a boot id and a process's start,
 * never by comparing clock times, which a clock step at boot would move.
 * A run only ever removes the lock holding its own token. A lock without an
 * owner (one an older build took, or whose process died between creating it
 * and writing the owner) goes stale after an hour, as before.
 *
 * Holding the lock is visible to everything the holder runs, so an entry
 * point that takes the lock itself (approve, say) simply runs when sync
 * calls it while already holding it. Sync also hands it to the commands its
 * fixes run (`t3-fleet secrets add-node` on an authority) through
 * T3_FLEET_SYNC_LOCK, the token: a process started with the holder's token
 * is part of its run.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { exec } from "./Exec.ts";
import { stateDir } from "./Names.ts";

const Owner = Schema.Struct({
  pid: Schema.Number,
  start: Schema.Number,
  token: Schema.String,
  /** The machine's boot when the lock was taken. */
  boot: Schema.optionalKey(Schema.String),
  /** The owner process's start, as the kernel keeps it. */
  process: Schema.optionalKey(Schema.String),
});
type Owner = typeof Owner.Type;
const decodeOwner = Schema.decodeEffect(Schema.fromJsonString(Owner));
const encodeOwner = Schema.encodeEffect(Schema.fromJsonString(Owner));

/** The tokens this process holds, which its pid alone cannot tell apart from a dead run's. */
const heldHere = new Set<string>();

/** True inside a run that holds the lock. */
const HoldsSyncLock = Context.Reference<boolean>("t3-fleet/HoldsSyncLock", { defaultValue: () => false });

export const syncLockPath = (home: string) => `${stateDir(home)}/sync.lock`;
export const SYNC_LOCK_ENV = "T3_FLEET_SYNC_LOCK";
const ownerPath = (lock: string) => `${lock}/owner.json`;

const OWNERLESS_STALE_MS = 3_600_000;
const TAKEOVER_STALE_MS = 60_000;

const alive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // EPERM: it exists, under another user.
      return (cause as { code?: string }).code === "EPERM";
    }
  });

/** This boot of the machine, or none when it cannot tell. */
const bootId = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform === "darwin") {
    const sysctl = yield* exec({ command: "sysctl", args: ["-n", "kern.bootsessionuuid"], timeout: Duration.seconds(5) });
    return sysctl.code === 0 && sysctl.stdout.trim() !== "" ? Option.some(sysctl.stdout.trim()) : Option.none<string>();
  }
  const id = yield* fs.readFileString("/proc/sys/kernel/random/boot_id").pipe(Effect.option);
  return Option.filter(Option.map(id, (t) => t.trim()), (t) => t !== "");
});

/**
 * When the process now at `pid` started, in the kernel's own terms: on Linux
 * clock ticks since boot (/proc/<pid>/stat), elsewhere ps's start time, which
 * the kernel records once. Neither moves when the clock is set. None when the
 * process is gone or nothing can say.
 */
export const processIdentity = (pid: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (Option.isSome(stat)) {
      // Field 22, counted after the command name, which may hold spaces and parentheses.
      const ticks = stat.value.slice(stat.value.lastIndexOf(")") + 2).split(" ")[19];
      return ticks === undefined ? Option.none<string>() : Option.some(`ticks ${ticks}`);
    }
    const ps = yield* exec({ command: "ps", args: ["-o", "lstart=", "-p", String(pid)], env: { LC_ALL: "C" }, extendEnv: true, timeout: Duration.seconds(5) });
    const start = ps.stdout.trim().replace(/\s+/g, " ");
    return ps.code === 0 && start !== "" ? Option.some(start) : Option.none<string>();
  });

/** Whether the run that wrote `owner` is still running. A lock from an older build records neither boot nor process. */
const ownerRuns = (owner: Owner) =>
  Effect.gen(function* () {
    if (!(yield* alive(owner.pid))) return false;
    const boot = yield* bootId;
    if (owner.boot !== undefined && Option.isSome(boot) && owner.boot !== boot.value) return false;
    const started = yield* processIdentity(owner.pid);
    return !(owner.process !== undefined && Option.isSome(started) && owner.process !== started.value);
  });

const readOwner = (lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(ownerPath(lock)).pipe(Effect.flatMap(decodeOwner), Effect.option);
  });

/** Written aside and renamed in, so a reader never sees half an owner. */
const writeOwner = (lock: string, owner: Owner) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const aside = `${lock}/owner.${owner.token}.json`;
    yield* fs.writeFileString(aside, yield* encodeOwner(owner));
    yield* fs.rename(aside, ownerPath(lock));
  });

const ageOf = (path: string, now: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(path).pipe(Effect.option);
    if (Option.isNone(stat)) return Option.none<number>();
    return Option.some(Option.match(stat.value.mtime, { onNone: () => Infinity, onSome: (t) => now - t.getTime() }));
  });

/** Free, held by a live run, or left behind by a dead one. */
const lockState = (lock: string, now: number) =>
  Effect.gen(function* () {
    const owner = yield* readOwner(lock);
    if (Option.isSome(owner)) {
      const { pid, token } = owner.value;
      if (pid === process.pid) return heldHere.has(token) ? "held" : "stale";
      return (yield* ownerRuns(owner.value)) ? "held" : "stale";
    }
    const age = yield* ageOf(lock, now);
    if (Option.isNone(age)) return "free";
    return age.value > OWNERLESS_STALE_MS ? "stale" : "held";
  });

/** This run's token, or null when another live run holds the lock. */
export const takeSyncLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const lock = syncLockPath(process.env["HOME"] ?? "");
  yield* fs.makeDirectory(lock.slice(0, lock.lastIndexOf("/")), { recursive: true }).pipe(Effect.ignore);
  const now = yield* Clock.currentTimeMillis;
  const boot = yield* bootId;
  const started = yield* processIdentity(process.pid);
  const owner: Owner = {
    pid: process.pid,
    start: now,
    token: `${process.pid}-${now}-${yield* Random.nextIntBetween(0, 2 ** 31)}`,
    ...(Option.isSome(boot) ? { boot: boot.value } : {}),
    ...(Option.isSome(started) ? { process: started.value } : {}),
  };
  // A directory without its owner would read as taken for an hour: one that cannot get its owner goes again.
  const create = fs.makeDirectory(lock).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((made) =>
      made
        ? writeOwner(lock, owner).pipe(
            Effect.as(true),
            Effect.catch(() => fs.remove(lock, { recursive: true }).pipe(Effect.ignore, Effect.as(false))),
          )
        : Effect.succeed(false),
    ),
  );
  const mine = Effect.sync(() => {
    heldHere.add(owner.token);
    return owner.token;
  });
  if (yield* create) return yield* mine;
  if ((yield* lockState(lock, now)) !== "stale") return null;

  // Taking a dead run's lock over: one taker at a time, judging again under
  // the guard, so two takers never both win. The guard is held for
  // milliseconds; one older than a minute was left by a taker that died.
  const guard = `${lock}.takeover`;
  if (!(yield* fs.makeDirectory(guard).pipe(Effect.as(true), Effect.orElseSucceed(() => false)))) {
    const age = yield* ageOf(guard, now);
    if (Option.isSome(age) && age.value > TAKEOVER_STALE_MS) yield* fs.remove(guard, { recursive: true }).pipe(Effect.ignore);
    return null;
  }
  const taken = yield* Effect.gen(function* () {
    const state = yield* lockState(lock, now);
    if (state === "free") return yield* create;
    if (state === "held") return false;
    return yield* writeOwner(lock, owner).pipe(Effect.as(true), Effect.orElseSucceed(() => false));
  }).pipe(Effect.ensuring(fs.remove(guard, { recursive: true }).pipe(Effect.ignore)));
  return taken ? yield* mine : null;
});

/** Remove the lock if it is still this run's; a lock someone took over stays theirs. */
export const releaseSyncLock = (token: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lock = syncLockPath(process.env["HOME"] ?? "");
    const owner = yield* readOwner(lock);
    if (Option.isSome(owner) && owner.value.token === token) yield* fs.remove(lock, { recursive: true }).pipe(Effect.ignore);
    heldHere.delete(token);
  });

/** Whether this process was started by the run holding the lock, with its token. */
const startedByHolder = Effect.gen(function* () {
  const inherited = process.env[SYNC_LOCK_ENV] ?? "";
  if (inherited === "") return false;
  const owner = yield* readOwner(syncLockPath(process.env["HOME"] ?? ""));
  return Option.isSome(owner) && owner.value.token === inherited;
});

/**
 * Run `effect` holding the lock, or `busy` when another run holds it. With
 * `children`, processes it starts are part of the run (sync's fixes).
 */
export const withSyncLock = <A, E, R, A2, E2, R2>(effect: Effect.Effect<A, E, R>, busy: Effect.Effect<A2, E2, R2>, options: { readonly children?: boolean } = {}) =>
  Effect.gen(function* () {
    if ((yield* HoldsSyncLock) || (yield* startedByHolder)) return yield* effect.pipe(Effect.provideService(HoldsSyncLock, true));
    const token = yield* takeSyncLock;
    if (token === null) return yield* busy;
    const share = options.children === true;
    const shared = share ? Effect.sync(() => (process.env[SYNC_LOCK_ENV] = token)) : Effect.void;
    const unshared = share ? Effect.sync(() => delete process.env[SYNC_LOCK_ENV]) : Effect.void;
    return yield* shared.pipe(
      Effect.andThen(effect),
      Effect.provideService(HoldsSyncLock, true),
      Effect.ensuring(unshared.pipe(Effect.andThen(releaseSyncLock(token)))),
    );
  });

/** Run `effect` holding the lock, so no sync proposes or pulls the repo halfway through an edit. */
export const underSyncLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withSyncLock(effect, Effect.fail("a sync is running on this machine; try again in a moment"));
