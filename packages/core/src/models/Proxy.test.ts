// The test is a black box: a plain Node server as the upstream, so it controls
// bytes and timing exactly, and plain fetch as the client.
// @effect-diagnostics globalFetch:off globalTimers:off
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import type * as Etag from "effect/unstable/http/Etag";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ModelProxyStats } from "../Api.ts";
import { egressLayer } from "./Egress.ts";
import { modelProxyLayer, proxyRefusal, type ModelProxyOptions } from "./Proxy.ts";

type Handler = (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse, n: number) => void;

interface Seen {
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A fake upstream on an ephemeral port; `handler` gets the attempt number. */
const upstream = async (handler: Handler) => {
  const seen: Array<Seen> = [];
  const server = NodeHttp.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res, seen.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen };
};

/** Serves routes on an ephemeral port and returns its URL. */
const serve = async (
  served: Layer.Layer<never, never, HttpServer.HttpServer | HttpClient.HttpClient | FileSystem.FileSystem | HttpPlatform.HttpPlatform | Etag.Generator>,
) => {
  const scope = await Effect.runPromise(Scope.make());
  const layer = served.pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 })),
    Layer.provide(FetchHttpClient.layer),
  );
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope));
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return HttpServer.formatAddress(Context.get(context, HttpServer.HttpServer).address);
};

const quiet = { disableLogger: true, disableListenLog: true } as const;

const proxy = (url: string, over: Partial<ModelProxyOptions> = {}) =>
  serve(
    HttpRouter.serve(modelProxyLayer({
      home: "/nonexistent",
      version: "test",
      egress: "direct",
      persist: false,
      retryBaseMs: 5,
      upstreams: () => ({ anthropic: { url }, openai: { url: `${url}/v1`, chatgptUrl: `${url}/backend-api/codex` }, local: { url: `${url}/local` } }),
      ...over,
    }), quiet),
  );

const stats = async (base: string) => Schema.decodeSync(Schema.fromJsonString(ModelProxyStats))(await (await fetch(`${base}/stats`)).text());

describe("model proxy against a fake upstream", () => {
  it("forwards the client's request unchanged, auth and identity headers included", async () => {
    const up = await upstream((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
    const base = await proxy(up.url);
    const response = await fetch(`${base}/anthropic/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: "Bearer sk-ant-oat01-x", "user-agent": "claude-cli/2.1.288", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: '{"model":"m"}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    const [got] = up.seen;
    expect(got?.url).toBe("/v1/messages?beta=true");
    expect(got?.body).toBe('{"model":"m"}');
    expect(got?.headers["authorization"]).toBe("Bearer sk-ant-oat01-x");
    expect(got?.headers["user-agent"]).toBe("claude-cli/2.1.288");
    expect(got?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(got?.headers["traceparent"]).toBeUndefined();
    expect(got?.headers["b3"]).toBeUndefined();
  });

  it("sends a ChatGPT login to the ChatGPT backend and an API key to the API", async () => {
    const up = await upstream((_req, res) => res.writeHead(200).end("{}"));
    const base = await proxy(up.url);
    await fetch(`${base}/openai/responses`, { method: "POST", headers: { authorization: "Bearer eyJa.eyJb.c", "chatgpt-account-id": "acct" }, body: "{}" });
    await fetch(`${base}/openai/responses`, { method: "POST", headers: { authorization: "Bearer sk-proj-x" }, body: "{}" });
    expect(up.seen.map((s) => s.url)).toEqual(["/backend-api/codex/responses", "/v1/responses"]);
    expect(up.seen[0]?.headers["chatgpt-account-id"]).toBe("acct");
  });

  it("serves any upstream the settings declare, and nothing else", async () => {
    const up = await upstream((_req, res) => res.writeHead(200).end("{}"));
    const base = await proxy(up.url);
    expect((await fetch(`${base}/local/v1/chat/completions`, { method: "POST", body: "{}" })).status).toBe(200);
    expect(up.seen[0]?.url).toBe("/local/v1/chat/completions");
    expect((await fetch(`${base}/nowhere/v1`)).status).toBe(404);
    expect((await stats(base)).upstreams.map((u) => u.upstream)).toEqual(["anthropic", "openai", "local"]);
  });

  it("retries 503 and 529 before the first byte, then answers", async () => {
    const up = await upstream((_req, res, n) => (n === 1 ? res.writeHead(503).end("busy") : n === 2 ? res.writeHead(529).end("overloaded") : res.writeHead(200).end("done")));
    const base = await proxy(up.url);
    const response = await fetch(`${base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
    expect(up.seen.length).toBe(3);
    expect(up.seen.every((s) => s.body === "{}")).toBe(true);
    const anthropic = (await stats(base)).upstreams.find((u) => u.upstream === "anthropic");
    expect(anthropic?.m5).toMatchObject({ requests: 1, retried: 1, failed: 0 });
  });

  it("gives up after three retries and passes the last answer on", async () => {
    const up = await upstream((_req, res) => res.writeHead(429, { "retry-after": "0" }).end("slow down"));
    const base = await proxy(up.url);
    const response = await fetch(`${base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("slow down");
    expect(up.seen.length).toBe(4);
    const anthropic = (await stats(base)).upstreams.find((u) => u.upstream === "anthropic");
    expect(anthropic?.h1.failures).toEqual({ "429": 1 });
    expect(anthropic?.lastError?.class).toBe("429");
  });

  it("does not retry a retry-after beyond 30s, or a 400", async () => {
    const up = await upstream((req, res) => (req.url === "/long" ? res.writeHead(429, { "retry-after": "120" }).end() : res.writeHead(400).end("bad")));
    const base = await proxy(up.url);
    expect((await fetch(`${base}/anthropic/long`)).status).toBe(429);
    expect((await fetch(`${base}/anthropic/bad`)).status).toBe(400);
    expect(up.seen.length).toBe(2);
  });

  it("never retries once the response has started; a broken stream reaches the client", async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => res.destroy(), 50);
    });
    const base = await proxy(up.url);
    const response = await fetch(`${base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    const body = await response.text().catch(() => "broken");
    expect(body === "broken" || body.startsWith("event: message_start")).toBe(true);
    expect(up.seen.length).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    const anthropic = (await stats(base)).upstreams.find((u) => u.upstream === "anthropic");
    expect(anthropic?.m5.failures).toEqual({ stream: 1 });
  });

  it("sends keepalive comments between events while the upstream is quiet", async () => {
    const up = await upstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: a\ndata: 1\n\n");
      setTimeout(() => res.end("event: b\ndata: 2\n\n"), 400);
    });
    const base = await proxy(up.url, { keepaliveEvery: "60 millis" });
    const body = await (await fetch(`${base}/anthropic/v1/messages`, { method: "POST", body: "{}" })).text();
    expect(body.startsWith("event: a\ndata: 1\n\n")).toBe(true);
    expect(body).toContain(": keepalive\n\n");
    expect(body.endsWith("event: b\ndata: 2\n\n")).toBe(true);
    // Every keepalive sits between events, never inside one.
    expect(body.replaceAll(": keepalive\n\n", "")).toBe("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  });

  it("retries a refused connection, then reports it as connect", async () => {
    const up = await upstream((_req, res) => res.end());
    const dead = up.url.replace(/:\d+$/, ":1");
    const base = await proxy(dead);
    const response = await fetch(`${base}/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    const anthropic = (await stats(base)).upstreams.find((u) => u.upstream === "anthropic");
    expect(anthropic?.m5).toMatchObject({ requests: 1, failed: 1, failures: { connect: 1 } });
  });

  it("answers only its loopback names, refusing DNS rebinding and other origins", async () => {
    const up = await upstream((_req, res) => res.writeHead(200).end("{}"));
    const base = await proxy(up.url);
    const port = Number(new URL(base).port);
    const status = (headers: Record<string, string>, path = "/anthropic/v1/messages") =>
      new Promise<number>((resolve) => {
        const req = NodeHttp.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => resolve(res.statusCode ?? 0));
        req.end("{}");
      });
    expect(await status({ host: `evil.example:${port}` })).toBe(421);
    expect(await status({ host: `127.0.0.1:${port + 1}` })).toBe(421);
    expect(await status({ host: `evil.example:${port}` }, "/stats")).toBe(421);
    expect(await status({ host: `localhost:${port}`, origin: "http://evil.example" })).toBe(403);
    expect(up.seen.length).toBe(0);
    expect(await status({ host: `localhost:${port}` })).toBe(200);
    expect(proxyRefusal({ host: "127.0.0.1:8398" }, 8398)).toBeNull();
    expect(proxyRefusal({}, 8398)?.status).toBe(421);
  });

  it("answers a WebSocket upgrade with 426 so Codex uses HTTP", async () => {
    const up = await upstream((_req, res) => res.end());
    const base = await proxy(up.url);
    const status = await new Promise<number>((resolve) => {
      const req = NodeHttp.request(`${base}/openai/responses`, { headers: { connection: "Upgrade", upgrade: "websocket" } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(426);
    expect(up.seen.length).toBe(0);
  });

  it("with egress = relay, goes through the relay's /egress route with the relay token", async () => {
    const up = await upstream((_req, res) => res.writeHead(200).end("via relay"));
    const relay = await serve(HttpRouter.serve(egressLayer("relay-secret", { allowInsecure: true }), quiet));
    const base = await proxy(up.url, { egress: "relay", relay: { url: relay, token: "relay-secret" } });
    const response = await fetch(`${base}/anthropic/v1/messages`, { method: "POST", headers: { authorization: "Bearer client" }, body: "{}" });
    expect(await response.text()).toBe("via relay");
    expect(up.seen[0]?.headers["authorization"]).toBe("Bearer client");
    expect(up.seen[0]?.url).toBe("/v1/messages");
    expect(up.seen[0]?.headers["x-fleetx-relay-token"]).toBeUndefined();
    expect(up.seen[0]?.headers["x-fleetx-egress-base"]).toBeUndefined();
    const refused = await fetch(`${relay}/egress/anthropic/v1/messages`, { method: "POST", body: "{}" });
    expect(refused.status).toBe(401);
  });
});
