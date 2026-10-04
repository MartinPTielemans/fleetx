/**
 * Who opened each upstream session, for the gateway: one client cannot use
 * another's session, and a session the hub has no record of is refused.
 *
 * A record ends with its session: a DELETE or a 404 from the upstream, or the
 * bridge ending it. A record for a proxied server also ends after a day
 * unused (the hub cannot see that session end); a bridged one does not, since
 * the bridge reports its sessions' ends itself. Beyond 10,000 records the
 * least recently used goes.
 *
 * Proxied servers' sessions outlive a relay restart, so their records are
 * kept in sessions.json in the hub's state directory: the server, the
 * client, and a SHA-256 of the session id, never the id itself. Bridged
 * sessions die with the relay and are not kept.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { sha256 } from "../Hash.ts";

const MAX_RECORDS = 10_000;
const IDLE = 24 * 60 * 60_000;

const Owner = Schema.Struct({ server: Schema.String, session: Schema.String, client: Schema.String, lastSeen: Schema.Number });
const OwnersFile = Schema.fromJsonString(Schema.Array(Owner));
const decodeFile = Schema.decodeUnknownOption(OwnersFile);
const encodeFile = Schema.encodeUnknownOption(OwnersFile);

interface OwnerRecord {
  readonly server: string;
  /** SHA-256 of the session id. */
  readonly session: string;
  readonly client: string;
  lastSeen: number;
  /** False for a bridged session, which the bridge ends itself. */
  readonly expires: boolean;
}

export interface SessionOwners {
  /** Whether `client` opened this session; a yes counts as a use. */
  readonly owns: (server: string, session: string, client: string) => Effect.Effect<boolean>;
  /** A session the upstream just opened; a session already recorded keeps its owner. */
  readonly record: (server: string, session: string, client: string, options: { readonly expires: boolean }) => Effect.Effect<void>;
  readonly end: (server: string, session: string) => Effect.Effect<void>;
  /** Drop records unused for a day. */
  readonly prune: Effect.Effect<void>;
}

export const makeSessionOwners = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Least recently used first.
    const records = new Map<string, OwnerRecord>();
    const keyOf = (server: string, hash: string) => `${server}\u0000${hash}`;
    const hashOf = (session: string) => Effect.promise(() => sha256(session));
    let dirty = false;

    const loaded = Option.getOrElse(decodeFile(yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "[]"))), () => []);
    const now = yield* Clock.currentTimeMillis;
    for (const o of [...loaded].sort((a, b) => a.lastSeen - b.lastSeen)) {
      if (now - o.lastSeen <= IDLE) records.set(keyOf(o.server, o.session), { ...o, expires: true });
    }

    const save = Effect.gen(function* () {
      if (!dirty) return;
      dirty = false;
      const kept = [...records.values()].filter((r) => r.expires).map(({ server, session, client, lastSeen }) => ({ server, session, client, lastSeen }));
      const text = Option.getOrNull(encodeFile(kept));
      if (text === null) return;
      const temp = `${file}.tmp`;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(temp, text, { mode: 0o600 });
      yield* fs.rename(temp, file);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`hub: cannot save session owners: ${String(cause)}`)));
    yield* save.pipe(Effect.delay(Duration.seconds(10)), Effect.forever, Effect.forkScoped);
    yield* Effect.addFinalizer(() => save);

    const owners: SessionOwners = {
      owns: (server, session, client) =>
        Effect.gen(function* () {
          const key = keyOf(server, yield* hashOf(session));
          const r = records.get(key);
          if (r === undefined || r.client !== client) return false;
          const now = yield* Clock.currentTimeMillis;
          records.delete(key);
          if (r.expires && now - r.lastSeen > IDLE) {
            dirty = true;
            return false;
          }
          // Saved when it moves by an hour: enough for a day's expiry, without a write per request.
          if (r.expires && now - r.lastSeen > 60 * 60_000) dirty = true;
          r.lastSeen = now;
          records.set(key, r);
          return true;
        }),
      record: (server, session, client, options) =>
        Effect.gen(function* () {
          const hash = yield* hashOf(session);
          const key = keyOf(server, hash);
          if (records.has(key)) return;
          for (const oldest of records.keys()) {
            if (records.size < MAX_RECORDS) break;
            records.delete(oldest);
          }
          records.set(key, { server, session: hash, client, lastSeen: yield* Clock.currentTimeMillis, expires: options.expires });
          if (options.expires) dirty = true;
        }),
      end: (server, session) =>
        Effect.gen(function* () {
          const key = keyOf(server, yield* hashOf(session));
          if (records.get(key)?.expires === true) dirty = true;
          records.delete(key);
        }),
      prune: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [key, r] of records) {
          if (!r.expires || now - r.lastSeen <= IDLE) continue;
          records.delete(key);
          dirty = true;
        }
      }),
    };
    return owners;
  });
