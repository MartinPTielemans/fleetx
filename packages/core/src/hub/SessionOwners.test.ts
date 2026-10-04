// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
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
