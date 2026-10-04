// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off globalTimers:off
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { generateX25519Identity } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { relayLayer } from "../Relay.ts";

const TOKEN = "relay-token-for-route-tests";
const stdioServer = new URL("./testing/fake-stdio-server.mjs", import.meta.url).pathname;

let handler: (request: Request) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-fleet-relay-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "mcp"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "mcp/local.json"), JSON.stringify({ kind: "hosted-stdio", command: process.execPath, args: [stdioServer] }));
  const app = relayLayer({
    token: TOKEN,
    repo,
    branch: "main",
    pollEvery: Duration.hours(1),
    hub: { repo, home: dir, enabled: true, ports: {}, relayUrl: "https://relay.example.test", identity: await generateX25519Identity(), version: "test", stateDir: join(dir, "state") },
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  handler = (request) => web.handler(request);
  dispose = web.dispose;
});
afterAll(() => dispose());

const relay = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`);
  return handler(new Request(`http://127.0.0.1:8399${path}`, { ...init, headers }));
};

describe("relay hub routes", () => {
  it("serves hub state to the relay token only", async () => {
    expect((await relay("/hub/servers", { token: null })).status).toBe(401);
    expect((await relay("/hub/servers", { token: "wrong" })).status).toBe(401);
    let servers: Array<{ name: string; state: string }> = [];
    for (let i = 0; i < 50; i++) {
      servers = (await (await relay("/hub/servers")).json()) as typeof servers;
      if (servers[0]?.state === "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(servers).toMatchObject([{ name: "local", state: "running", kind: "hosted-stdio", auth: "none" }]);
    expect((await relay("/hub/servers/nope/restart", { method: "POST" })).status).toBe(404);
    expect((await relay("/hub/servers/local/login", { method: "POST" })).status).toBe(409);
  });

  it("gateways MCP over HTTP with sessions and streaming", async () => {
    const init = await relay("/mcp/local", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect(init.status).toBe(200);
    const session = init.headers.get("mcp-session-id") ?? "";
    expect(session).not.toBe("");
    expect(await init.json()).toMatchObject({ id: 1, result: { serverInfo: { name: "fake" } } });
    const call = await relay("/mcp/local", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }),
    });
    expect(call.headers.get("content-type")).toContain("text/event-stream");
    expect(await call.text()).toContain("hi (init 1)");
    expect((await relay("/mcp/local", { method: "POST", token: null, body: "{}" })).status).toBe(401);

    const calls = (await (await relay("/hub/calls?server=local&limit=5")).json()) as Array<{ method: string; tool: string | null; outcome: string }>;
    expect(calls[0]).toMatchObject({ method: "POST", outcome: "unauthorized" });
    expect(calls[1]).toMatchObject({ method: "tools/call", tool: "echo", outcome: "ok" });
  });

  it("checks the token before reading a body, and refuses bodies over 4 MB", async () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const before = ((await (await relay("/hub/calls?server=local&limit=1000")).json()) as Array<unknown>).length;
    expect((await relay("/mcp/local", { method: "POST", token: "wrong", body: huge })).status).toBe(401);
    const after = (await (await relay("/hub/calls?server=local&limit=1000")).json()) as Array<{ method: string; outcome: string }>;
    expect(after.length).toBe(before + 1);
    expect(after[0]).toMatchObject({ method: "POST", outcome: "unauthorized" });
    expect((await relay("/mcp/local", { method: "POST", body: huge })).status).toBe(413);
    // Without a content-length the reader stops at the limit too.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    });
    expect((await relay("/mcp/local", { method: "POST", body: stream, duplex: "half" } as RequestInit)).status).toBe(413);
  });

  it("manages client tokens and answers OAuth callbacks with a small page", async () => {
    const created = await relay("/hub/tokens/laptop", { method: "POST", body: JSON.stringify({ servers: ["local"] }) });
    const { token } = (await created.json()) as { token: string };
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await (await relay("/hub/tokens")).json()).toMatchObject([{ client: "laptop", servers: ["local"] }]);
    expect((await relay("/hub/tokens", { token })).status).toBe(401);
    expect((await relay("/hub/tokens/laptop", { method: "DELETE" })).status).toBe(204);
    expect((await relay("/hub/tokens/laptop", { method: "DELETE" })).status).toBe(404);

    const page = await relay("/oauth/callback?code=x&state=<script>", { token: null });
    expect(page.status).toBe(400);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Sign-in failed");
    expect(html).not.toContain("<script>");
  });
});
