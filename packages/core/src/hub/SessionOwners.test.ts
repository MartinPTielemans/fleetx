// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect, it } from "vite-plus/test";

import { makeSessionOwners } from "./SessionOwners.ts";

it("a proxied session's owner lapses after a day unused; a bridged one lasts until the bridge ends it", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "t3-fleet-owners-")), "sessions.json");
  await Effect.runPromise(
    Effect.gen(function* () {
      const owners = yield* makeSessionOwners(file);
      yield* owners.record("remote", "r-1", "laptop", { expires: true });
      yield* owners.record("local", "b-1", "laptop", { expires: false });
      yield* owners.record("local", "b-1", "intruder", { expires: false });
      expect(yield* owners.owns("local", "b-1", "intruder")).toBe(false);
      yield* TestClock.adjust("25 hours");
      yield* owners.prune;
      expect(yield* owners.owns("remote", "r-1", "laptop")).toBe(false);
      expect(yield* owners.owns("local", "b-1", "laptop")).toBe(true);
      yield* owners.end("local", "b-1");
      expect(yield* owners.owns("local", "b-1", "laptop")).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );
  // Only proxied sessions are kept on disk, and only as hashes.
  expect(readFileSync(file, "utf8")).toBe("[]");
});

it("stopping waits for a save under way, then saves the final state; saves never overlap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-fleet-owners-"));
  const file = join(dir, "sessions.json");
  let writing = 0;
  let most = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const started = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      const nextDone = yield* Deferred.make<void>();
      let writes = 0;
      // The first save, the periodic one, cannot be called back once begun, like a write the
      // system has started: it holds until the hub stops, then until the next save is done (or a
      // while, when that save waits for it, as it should).
      const held: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (path, data, options) =>
          Effect.suspend(() => {
            const first = ++writes === 1;
            const write = Effect.sync(() => (most = Math.max(most, ++writing))).pipe(
              Effect.andThen(
                first
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(stopping)),
                      Effect.andThen(
                        Effect.raceFirst(
                          Deferred.await(nextDone),
                          TestClock.withLive(Effect.sleep("200 millis")),
                        ),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.andThen(fs.writeFileString(path, data, options)),
              Effect.ensuring(Effect.sync(() => writing--)),
            );
            return first
              ? Effect.uninterruptible(write)
              : write.pipe(Effect.ensuring(Deferred.succeed(nextDone, undefined)));
          }),
      };
      yield* Effect.gen(function* () {
        const owners = yield* makeSessionOwners(file);
        // Added last, so it runs first when the scope closes: the hub is stopping.
        yield* Effect.addFinalizer(() => Deferred.succeed(stopping, undefined));
        yield* owners.record("remote", "r-1", "laptop", { expires: true });
        // The periodic save starts with the record in it, and holds.
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.await(started);
        yield* owners.end("remote", "r-1");
      }).pipe(Effect.scoped, Effect.provideService(FileSystem.FileSystem, held));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );
  expect(most).toBe(1);
  expect(readFileSync(file, "utf8")).toBe("[]");
  expect(readdirSync(dir)).toEqual(["sessions.json"]);
});
