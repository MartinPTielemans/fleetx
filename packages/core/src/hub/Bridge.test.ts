import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { makeBridge, type Bridge } from "./Bridge.ts";
import { makeSseParser, parseJson, toJson, type JsonRpcMessage } from "./JsonRpc.ts";
import { spawnStdio } from "./Process.ts";
import { readBody } from "./Upstream.ts";

const server = new URL("./testing/fake-stdio-server.mjs", import.meta.url).pathname;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));

const bridgedWith = (
  options: { readonly sessionIdle?: Duration.Input; readonly requestTimeout?: Duration.Input } = {},
) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<NodeServices.NodeServices>();
    return yield* makeBridge({
      name: "fake",
      spawn: spawnStdio({ command: process.execPath, args: [server], env: {} }).pipe(
        Effect.provide(services),
      ),
      ...options,
    });
  });
const bridged = bridgedWith();

const post = (
  bridge: Bridge,
  body: unknown,
  session?: string,
  accept = "application/json, text/event-stream",
) =>
  bridge.forward({
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
      ...(session === undefined ? {} : { "mcp-session-id": session }),
    },
    body: toJson(body),
  });

const initialize = (bridge: Bridge, id: number) =>
  Effect.gen(function* () {
    const response = yield* post(bridge, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    const message = parseJson(yield* readBody(response)) as JsonRpcMessage;
    return { session: response.headers["mcp-session-id"] ?? "", message };
  });

/** Every JSON-RPC message in an SSE or JSON response. */
const messages = (response: {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array, unknown>;
}) =>
  Effect.gen(function* () {
    const text = yield* response.body.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.orElseSucceed(() => ""),
    );
    if (!(response.headers["content-type"] ?? "").includes("event-stream"))
      return [parseJson(text) as JsonRpcMessage];
    return makeSseParser()(text).map((e) => parseJson(e.data) as JsonRpcMessage);
  });

const call = (
  bridge: Bridge,
  session: string,
  id: number,
  text: string,
  delayMs: number,
  progressToken?: string,
) =>
  post(
    bridge,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "echo",
        arguments: { text, delayMs },
        ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
      },
    },
    session,
  ).pipe(Effect.flatMap(messages));

describe("stdio bridge", () => {
  it("serves two concurrent clients from one process", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const [a, b] = yield* Effect.all([initialize(bridge, 1), initialize(bridge, 1)], {
          concurrency: 2,
        });
        expect(a.session).not.toBe("");
        expect(a.session).not.toBe(b.session);
        expect(a.message).toMatchObject({ id: 1, result: { serverInfo: { name: "fake" } } });
        expect(b.message).toMatchObject({ id: 1, result: { serverInfo: { name: "fake" } } });

        // Both use id 7; the slower request is sent first. Progress goes only to the client that asked.
        const [slow, fast] = yield* Effect.all(
          [
            call(bridge, a.session, 7, "from a", 150, "pa"),
            call(bridge, b.session, 7, "from b", 0),
          ],
          { concurrency: 2 },
        );
        expect(slow.at(-1)).toMatchObject({
          id: 7,
          result: { content: [{ text: "from a (init 1)" }] },
        });
        expect(slow[0]).toMatchObject({
          method: "notifications/progress",
          params: { progressToken: "pa" },
        });
        expect(fast).toHaveLength(1);
        expect(fast[0]).toMatchObject({
          id: 7,
          result: { content: [{ text: "from b (init 1)" }] },
        });

        // JSON when the client does not accept SSE.
        const json = yield* post(
          bridge,
          { jsonrpc: "2.0", id: "x", method: "tools/list" },
          a.session,
          "application/json",
        ).pipe(Effect.flatMap(messages));
        expect(json[0]).toMatchObject({
          id: "x",
          result: {
            tools: [
              { name: "echo" },
              { name: "notify" },
              { name: "crash" },
              { name: "delete_all" },
            ],
          },
        });

        // Notifications from the server fan out to every client's GET stream.
        const streamOf = (session: string) =>
          bridge
            .forward({
              method: "GET",
              headers: { accept: "text/event-stream", "mcp-session-id": session },
              body: "",
            })
            .pipe(
              Effect.flatMap((r) =>
                r.body.pipe(
                  Stream.decodeText(),
                  Stream.filter((t) => !t.startsWith(":")),
                  Stream.take(1),
                  Stream.mkString,
                ),
              ),
              Effect.forkScoped,
            );
        const ga = yield* streamOf(a.session);
        const gb = yield* streamOf(b.session);
        yield* Effect.sleep(Duration.millis(50));
        yield* post(
          bridge,
          { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "notify" } },
          a.session,
        ).pipe(Effect.flatMap(messages));
        for (const fiber of [ga, gb]) {
          const frame = yield* Fiber.join(fiber);
          expect(frame).toContain("notifications/tools/list_changed");
        }

        // A log message reaches only the client whose request is in flight, never another's stream.
        const gaLog = yield* streamOf(a.session);
        const gbLog = yield* streamOf(b.session);
        yield* Effect.sleep(Duration.millis(50));
        const logged = yield* post(
          bridge,
          {
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: { name: "echo", arguments: { text: "mine", log: true } },
          },
          a.session,
        ).pipe(Effect.flatMap(messages));
        expect(logged.map((m) => m.method ?? "response")).toEqual([
          "notifications/message",
          "response",
        ]);
        yield* post(
          bridge,
          { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "notify" } },
          b.session,
        ).pipe(Effect.flatMap(messages));
        for (const fiber of [gaLog, gbLog]) {
          const frame = yield* Fiber.join(fiber);
          expect(frame).toContain("list_changed");
          expect(frame).not.toContain("working on");
        }

        // Unknown sessions are 404; a request without a session is 400; notifications get 202.
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 1, method: "ping" }, "nope")).status,
        ).toBe(404);
        expect((yield* post(bridge, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(400);
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", method: "notifications/initialized" }, a.session))
            .status,
        ).toBe(202);
      }),
    );
  }, 20_000);

  it("fails outstanding requests when the process dies, then restarts and re-initializes", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const { session } = yield* initialize(bridge, 1);
        const crashed = yield* post(
          bridge,
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "crash" } },
          session,
        ).pipe(Effect.flatMap(messages));
        expect(crashed.at(-1)).toMatchObject({ id: 2, error: { code: -32603 } });
        // The session survives; the next call waits for the new process.
        let answer: ReadonlyArray<JsonRpcMessage> = [];
        for (let i = 0; i < 40; i++) {
          yield* Effect.sleep(Duration.millis(100));
          if ((yield* bridge.status).state !== "running") continue;
          answer = yield* call(bridge, session, 3, "again", 0);
          break;
        }
        expect(answer.at(-1)).toMatchObject({
          id: 3,
          result: { content: [{ text: "again (init 1)" }] },
        });
        expect((yield* bridge.request("ping")).result).toEqual({});
      }),
    );
  }, 20_000);

  it("answers a server's ping with an empty result", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const { session } = yield* initialize(bridge, 1);
        const answer = yield* post(
          bridge,
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ping_me" } },
          session,
        ).pipe(Effect.flatMap(messages));
        expect(answer.at(-1)).toMatchObject({ id: 2, result: { content: [{ text: "pong {}" }] } });
      }),
    );
  }, 20_000);

  it("makes room for a new session by evicting the least recently seen one with nothing in flight", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const sessions: Array<string> = [];
        // The first session is the least recently seen, but its call is still running: the second goes instead.
        sessions.push((yield* initialize(bridge, 0)).session);
        const running = yield* call(bridge, sessions[0] ?? "", 1, "still running", 3000).pipe(
          Effect.forkScoped,
        );
        yield* Effect.sleep(Duration.millis(50));
        for (let i = 1; i < 1000; i++) sessions.push((yield* initialize(bridge, i)).session);
        const newest = yield* initialize(bridge, 1001);
        expect(newest.message).toMatchObject({
          id: 1001,
          result: { serverInfo: { name: "fake" } },
        });
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 2, method: "ping" }, newest.session)).status,
        ).toBe(200);
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 3, method: "ping" }, sessions[1])).status,
        ).toBe(404);
        expect((yield* Fiber.join(running)).at(-1)).toMatchObject({
          id: 1,
          result: { content: [{ text: "still running (init 1)" }] },
        });
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 4, method: "ping" }, sessions[0])).status,
        ).toBe(200);
      }),
    );
  }, 30_000);

  it("expires idle sessions without an open stream or a call in flight, and keeps the others", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridgedWith({ sessionIdle: Duration.millis(300) });
        const idle = yield* initialize(bridge, 1);
        const watched = yield* initialize(bridge, 2);
        const busy = yield* initialize(bridge, 3);
        yield* call(bridge, busy.session, 9, "slow", 1200).pipe(Effect.forkScoped);
        const stream = yield* bridge.forward({
          method: "GET",
          headers: { accept: "text/event-stream", "mcp-session-id": watched.session },
          body: "",
        });
        yield* stream.body.pipe(Stream.runDrain, Effect.forkScoped);
        yield* Effect.sleep(Duration.millis(600));
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 1, method: "ping" }, idle.session)).status,
        ).toBe(404);
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 2, method: "ping" }, watched.session)).status,
        ).toBe(200);
        expect(
          (yield* post(bridge, { jsonrpc: "2.0", id: 3, method: "ping" }, busy.session)).status,
        ).toBe(200);
      }),
    );
  }, 20_000);

  it("keeps a long request alive while it reports progress", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridgedWith({ requestTimeout: Duration.millis(400) });
        const { session } = yield* initialize(bridge, 1);
        const answer = yield* post(
          bridge,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "echo",
              arguments: { text: "long", delayMs: 1500, progressEveryMs: 100 },
              _meta: { progressToken: "p" },
            },
          },
          session,
        ).pipe(Effect.flatMap(messages));
        expect(answer.at(-1)).toMatchObject({
          id: 2,
          result: { content: [{ text: "long (init 1)" }] },
        });
      }),
    );
  }, 20_000);

  it("tells the server when a client gives up on a request", async () => {
    await run(
      Effect.gen(function* () {
        const bridge = yield* bridged;
        const { session } = yield* initialize(bridge, 1);
        const slow = yield* post(
          bridge,
          {
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "echo", arguments: { text: "slow", delayMs: 10_000 } },
          },
          session,
        );
        const reading = yield* slow.body.pipe(Stream.runDrain, Effect.forkScoped);
        yield* Effect.sleep(Duration.millis(200));
        yield* Fiber.interrupt(reading);
        const answer = yield* post(
          bridge,
          { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cancelled" } },
          session,
        ).pipe(Effect.flatMap(messages));
        const text =
          (answer.at(-1)?.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]
            ?.text ?? "";
        expect(parseJson(text)).toHaveLength(1);
      }),
    );
  }, 20_000);

  it("fails pending requests and ends streams when it stops, and answers at once afterwards", async () => {
    await run(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const bridge = yield* bridged.pipe(Scope.provide(scope));
        const { session } = yield* initialize(bridge, 1);
        const stream = yield* bridge.forward({
          method: "GET",
          headers: { accept: "text/event-stream", "mcp-session-id": session },
          body: "",
        });
        const streaming = yield* stream.body.pipe(Stream.runDrain, Effect.forkScoped);
        const pending = yield* call(bridge, session, 2, "never", 60_000).pipe(Effect.forkScoped);
        yield* Effect.sleep(Duration.millis(200));
        yield* Scope.close(scope, Exit.void);
        const failed = yield* Fiber.join(pending).pipe(Effect.timeout(Duration.seconds(2)));
        expect(failed.at(-1)).toMatchObject({ id: 2, error: { code: -32603 } });
        yield* Fiber.join(streaming).pipe(Effect.timeout(Duration.seconds(2)), Effect.ignore);
        expect(streaming.pollUnsafe()).toBeDefined();
        // The stale bridge answers new requests at once instead of leaving them hanging.
        const after = yield* post(
          bridge,
          { jsonrpc: "2.0", id: 3, method: "tools/list" },
          session,
        ).pipe(Effect.flatMap(messages), Effect.timeout(Duration.seconds(2)));
        expect(after[0]?.error ?? after[0]?.result).toBeDefined();
        expect(
          yield* bridge.request("ping").pipe(Effect.flip, Effect.timeout(Duration.seconds(2))),
        ).toMatch(/stopped|not running/);
      }),
    );
  }, 20_000);
});
