// A plain test writing temp files; the effect under test runs with Node's services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { newBuild } from "./Runtime.ts";

describe("newBuild", () => {
  it("completes once the bundle holds a different build, and not before", async () => {
    const bundle = join(mkdtempSync(join(tmpdir(), "t3-fleet-build-")), "t3-fleet.mjs");
    writeFileSync(bundle, "old build");
    const watch = newBuild(bundle, Duration.millis(20)).pipe(Effect.provide(NodeServices.layer));
    const unchanged = await Effect.runPromise(watch.pipe(Effect.timeout(Duration.millis(200)), Effect.option));
    expect(unchanged._tag).toBe("None");
    const replace = Effect.sleep(Duration.millis(60)).pipe(Effect.flatMap(() => Effect.sync(() => writeFileSync(bundle, "new build"))));
    const [digest] = await Effect.runPromise(Effect.all([watch, replace], { concurrency: 2 }));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);
});
