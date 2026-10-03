import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { makeBridge, type Bridge } from "./Bridge.ts";
import { makeSseParser, parseJson, toJson, type JsonRpcMessage } from "./JsonRpc.ts";
import { spawnStdio } from "./Process.ts";
import { readBody } from "./Upstream.ts";

const server = new URL("./testing/fake-stdio-server.mjs", import.meta.url).pathname;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

const bridged = Effect.gen(function* () {
  const services = yield* Effect.context<NodeServices.NodeServices>();
  return yield* makeBridge({ name: "fake", spawn: spawnStdio({ command: process.execPath, args: [server], env: {} }).pipe(Effect.provide(services)) });
});

const post = (bridge: Bridge, body: unknown, session?: string, accept = "application/json, text/event-stream") =>
  bridge.forward({
    method: "POST",
    headers: { "content-type": "application/json", accept, ...(session === undefined ? {} : { "mcp-session-id": session }) },
    body: toJson(body),
  });

const initialize = (bridge: Bridge, id: number) =>
  Effect.gen(function* () {
    const response = yield* post(bridge, { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    const message = parseJson(yield* readBody(response)) as JsonRpcMessage;
    return { session: response.headers["mcp-session-id"] ?? "", message };
  });

/** Every JSON-RPC message in an SSE or JSON response. */
const messages = (response: { readonly headers: Readonly<Record<string, string>>; readonly body: Stream.Stream<Uint8Array, unknown> }) =>
  Effect.gen(function* () {
    const text = yield* response.body.pipe(Stream.decodeText(), Stream.mkString, Effect.orElseSucceed(() => ""));
    if (!(response.headers["content-type"] ?? "").includes("event-stream")) return [parseJson(text) as JsonRpcMessage];
    return makeSseParser()(text).map((e) => parseJson(e.data) as JsonRpcMessage);
  });

const call = (bridge: Bridge, session: string, id: number, text: string, delayMs: number, progressToken?: string) =>
  post(
    bridge,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { text, delayMs }, ...(progressToken === undefined ? {} : { _meta: { progressToken } }) } },
    session,
  ).pipe(Effect.flatMap(messages));

describe("stdio bridge", () => {
  it("serves two concurrent clients from one process", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const [a, b] = yield* Effect.all([initialize(bridge, 1), initialize(bridge, 1)], { concurrency: 2 });
        expect(a.session).not.toBe("");
        expect(a.session).not.toBe(b.session);
        expect(a.message).toMatchObject({ id: 1, result: { serverInfo: { name: "fake" } } });
        expect(b.message).toMatchObject({ id: 1, result: { serverInfo: { name: "fake" } } });

        // Both use id 7; the slower request is sent first. Progress goes only to the client that asked.
        const [slow, fast] = yield* Effect.all([call(bridge, a.session, 7, "from a", 150, "pa"), call(bridge, b.session, 7, "from b", 0)], { concurrency: 2 });
        expect(slow.at(-1)).toMatchObject({ id: 7, result: { content: [{ text: "from a (init 1)" }] } });
        expect(slow[0]).toMatchObject({ method: "notifications/progress", params: { progressToken: "pa" } });
        expect(fast).toHaveLength(1);
        expect(fast[0]).toMatchObject({ id: 7, result: { content: [{ text: "from b (init 1)" }] } });

        // JSON when the client does not accept SSE.
        const json = yield* post(bridge, { jsonrpc: "2.0", id: "x", method: "tools/list" }, a.session, "application/json").pipe(Effect.flatMap(messages));
        expect(json[0]).toMatchObject({ id: "x", result: { tools: [{ name: "echo" }, { name: "notify" }, { name: "crash" }, { name: "delete_all" }] } });

        // Notifications from the server fan out to every client's GET stream.
        const streamOf = (session: string) =>
          bridge.forward({ method: "GET", headers: { accept: "text/event-stream", "mcp-session-id": session }, body: "" }).pipe(
            Effect.flatMap((r) => r.body.pipe(Stream.decodeText(), Stream.filter((t) => !t.startsWith(":")), Stream.take(1), Stream.mkString)),
            Effect.forkScoped,
          );
        const ga = yield* streamOf(a.session);
        const gb = yield* streamOf(b.session);
        yield* Effect.sleep(Duration.millis(50));
        yield* post(bridge, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "notify" } }, a.session).pipe(Effect.flatMap(messages));
        for (const fiber of [ga, gb]) {
          const frame = yield* Fiber.join(fiber);
          expect(frame).toContain("notifications/tools/list_changed");
        }

        // Unknown sessions are 404; a request without a session is 400; notifications get 202.
        expect((yield* post(bridge, { jsonrpc: "2.0", id: 1, method: "ping" }, "nope")).status).toBe(404);
        expect((yield* post(bridge, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(400);
        expect((yield* post(bridge, { jsonrpc: "2.0", method: "notifications/initialized" }, a.session)).status).toBe(202);
      }),
    );
  }, 20_000);

  it("fails outstanding requests when the process dies, then restarts and re-initializes", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const { session } = yield* initialize(bridge, 1);
        const crashed = yield* post(bridge, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crash" } }, session).pipe(Effect.flatMap(messages));
        expect(crashed.at(-1)).toMatchObject({ id: 2, error: { code: -32603 } });
        // The session survives; the next call waits for the new process.
        let answer: ReadonlyArray<JsonRpcMessage> = [];
        for (let i = 0; i < 40; i++) {
          yield* Effect.sleep(Duration.millis(100));
          if ((yield* bridge.status).state !== "running") continue;
          answer = yield* call(bridge, session, 3, "again", 0);
          break;
        }
        expect(answer.at(-1)).toMatchObject({ id: 3, result: { content: [{ text: "again (init 1)" }] } });
        expect((yield* bridge.request("ping")).result).toEqual({});
      }),
    );
  }, 20_000);
});
