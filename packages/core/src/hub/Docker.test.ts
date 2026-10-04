// Real throwaway containers, from an image already on the machine; skipped without Docker or the image.
// @effect-diagnostics nodeBuiltinImport:off globalRandom:off preferSchemaOverJson:off
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { afterAll, describe, expect, it } from "vite-plus/test";

import type { HubServer } from "../Api.ts";
import { containerName, PORT_RANGE } from "./Docker.ts";
import { makeHub, type Hub } from "./Hub.ts";
import { messagesInBody, toJson } from "./JsonRpc.ts";
import { readBody } from "./Upstream.ts";

const IMAGE = "python:3-alpine";
const available = (() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const code = readFileSync(new URL("./testing/fake_mcp.py", import.meta.url), "utf8");
const suffix = Math.random().toString(36).slice(2, 8);
const names = { http: `fxtest-http-${suffix}`, stdio: `fxtest-stdio-${suffix}` };

const containerId = (name: string) => {
  try {
    return execFileSync("docker", ["inspect", "--format", "{{.Id}}", name], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

afterAll(() => {
  if (!available) return;
  for (const name of Object.values(names)) {
    try {
      execFileSync("docker", ["rm", "-f", containerName(name)], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices | HttpClient.HttpClient>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));

const waitFor = (hub: Hub, name: string, state: HubServer["state"], seconds: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < seconds * 4; i++) {
      const s = (yield* hub.servers).find((x) => x.name === name);
      if (s?.state === state) return s;
      yield* Effect.sleep(Duration.millis(250));
    }
    return yield* Effect.die(new Error(`${name} never reached ${state}: ${toJson((yield* hub.servers).find((x) => x.name === name))}`));
  });

const call = (hub: Hub, name: string) =>
  Effect.gen(function* () {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = yield* hub.gateway(name, "Bearer t", {
      method: "POST",
      headers,
      body: toJson({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    yield* readBody(init);
    const session = init.headers["mcp-session-id"];
    const response = yield* hub.gateway(name, "Bearer t", {
      method: "POST",
      headers: { ...headers, ...(session === undefined ? {} : { "mcp-session-id": session }) },
      body: toJson({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hello", arguments: {} } }),
    });
    return messagesInBody(response.headers["content-type"], yield* readBody(response))[0]?.result;
  });

describe.skipIf(!available)("hub Docker runner", () => {
  it("runs HTTP and stdio images hardened on loopback, adopts a running container after a restart, and restarts one that dies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3-fleet-hub-docker-"));
    mkdirSync(join(dir, "repo/mcp"), { recursive: true });
    writeFileSync(join(dir, "repo/mcp", `${names.http}.json`), toJson({ kind: "container", image: IMAGE, transport: "streamable-http", args: ["python", "-c", code, "http"], env: { GREETING: "$GREETING" } }));
    writeFileSync(join(dir, "repo/mcp", `${names.stdio}.json`), toJson({ kind: "registry", image: IMAGE, transport: "stdio", network: "none", args: ["python", "-u", "-c", code, "stdio"] }));
    const identity = await generateX25519Identity();
    const start = makeHub(
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
        secrets: Effect.succeed({ GREETING: "secret-greeting" }),
      },
      () => Effect.void,
    );

    let firstId = "";
    await run(
      Effect.gen(function* () {
        const hub = yield* start;
        const http = yield* waitFor(hub, names.http, "running", 60);
        expect(http.tools).toBe(1);
        expect(yield* call(hub, names.http)).toMatchObject({ content: [{ text: "hello from docker" }] });
        const stdio = yield* waitFor(hub, names.stdio, "running", 60);
        expect(stdio.tools).toBe(1);
        expect(yield* call(hub, names.stdio)).toMatchObject({ content: [{ text: "hello from docker" }] });

        const inspected = JSON.parse(execFileSync("docker", ["inspect", containerName(names.http)], { encoding: "utf8" }))[0];
        expect(inspected.HostConfig.CapDrop).toEqual(["ALL"]);
        expect(inspected.HostConfig.SecurityOpt).toContain("no-new-privileges");
        const binding = Object.values(inspected.HostConfig.PortBindings as Record<string, Array<{ HostIp: string; HostPort: string }>>)[0]?.[0];
        expect(binding?.HostIp).toBe("127.0.0.1");
        expect(Number(binding?.HostPort)).toBeGreaterThanOrEqual(PORT_RANGE.first);
        expect(Number(binding?.HostPort)).toBeLessThanOrEqual(PORT_RANGE.last);
        // The secret reaches the container's environment, never its command line.
        expect(inspected.Config.Env).toContain("GREETING=secret-greeting");
        expect(JSON.stringify(inspected.Args)).not.toContain("secret-greeting");
        const stdioInspected = JSON.parse(execFileSync("docker", ["inspect", containerName(names.stdio)], { encoding: "utf8" }))[0];
        expect(stdioInspected.HostConfig.NetworkMode).toBe("none");
        firstId = containerId(containerName(names.http));
      }),
    );

    // A new hub (as after a relay restart) adopts the running container instead of starting a second.
    await run(
      Effect.gen(function* () {
        const hub = yield* start;
        yield* waitFor(hub, names.http, "running", 30);
        expect(containerId(containerName(names.http))).toBe(firstId);

        // A container that dies is started again.
        execFileSync("docker", ["rm", "-f", containerName(names.http)], { stdio: "ignore" });
        yield* waitFor(hub, names.http, "error", 30);
        yield* waitFor(hub, names.http, "running", 60);
        expect(yield* call(hub, names.http)).toMatchObject({ content: [{ text: "hello from docker" }] });
      }),
    );
  }, 180_000);
});
