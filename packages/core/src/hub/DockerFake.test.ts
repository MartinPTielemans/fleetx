// A fake docker CLI on PATH: container races, deterministically and without Docker.
// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { generateX25519Identity } from "age-encryption";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { containerName, ensureHttpContainer } from "./Docker.ts";
import { makeHub, type HubEvent } from "./Hub.ts";
import { toJson } from "./JsonRpc.ts";

const fake = new URL("./testing/fake-docker.mjs", import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), "t3-fleet-fake-docker-"));

beforeAll(() => {
  const bin = join(state, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, {
    mode: 0o755,
  });
  process.env["PATH"] = `${bin}:${process.env["PATH"] ?? ""}`;
  process.env["FAKE_DOCKER_DIR"] = state;
  process.env["FAKE_DOCKER_SLOW_RM_MS"] = "400";
});

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices | HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );

const containers = () =>
  JSON.parse(readFileSync(join(state, "containers.json"), "utf8")) as Record<
    string,
    { Config: { Labels: Record<string, string> } }
  >;

describe("hub containers", () => {
  it("never removes a container another hub started", async () => {
    writeFileSync(join(state, "conflict-once"), "");
    const failure = await run(
      ensureHttpContainer(
        { server: "taken", image: "example/server:1", args: [], env: {}, targetPort: 8080 },
        new Set(),
      ).pipe(Effect.flip),
    );
    expect(failure).toMatch(/already in use/);
    expect(containers()[containerName("taken")]?.Config.Labels["dev.t3-fleet.run"]).toBe(
      "someone-else",
    );
  });

  it("restarts a container server without a reload starting a second copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-hub-"));
    mkdirSync(join(dir, "repo/mcp"), { recursive: true });
    writeFileSync(
      join(dir, "repo/mcp/boxed.json"),
      toJson({ kind: "container", image: "example/server:1" }),
    );
    const identity = await generateX25519Identity();
    const events: Array<HubEvent> = [];
    await run(
      Effect.gen(function* () {
        const hub = yield* makeHub(
          {
            repo: join(dir, "repo"),
            home: dir,
            enabled: true,
            ports: {},
            relayUrl: null,
            identity,
            relayToken: "t",
            version: "test",
            stateDir: join(dir, "state"),
            checkEvery: Duration.hours(1),
            secrets: Effect.succeed({}),
          },
          (e) => Effect.sync(() => events.push(e)),
        );
        for (let i = 0; i < 100 && containers()[containerName("boxed")] === undefined; i++)
          yield* Effect.sleep(Duration.millis(50));
        const before = events.filter((e) => e.state === "starting").length;
        // The minute's reload lands while the restart has stopped the server and not yet started it again.
        yield* Effect.all(
          [hub.restart("boxed"), hub.check().pipe(Effect.delay(Duration.millis(100)))],
          { concurrency: "unbounded" },
        );
        expect(events.filter((e) => e.state === "starting").length - before).toBe(1);

        // Once its definition is gone, nothing starts it again.
        unlinkSync(join(dir, "repo/mcp/boxed.json"));
        yield* hub.check();
        expect(containers()[containerName("boxed")]).toBeUndefined();
        expect((yield* hub.servers).map((s) => s.name)).toEqual([]);
      }),
    );
  }, 30_000);
});
