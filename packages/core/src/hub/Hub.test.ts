// Fixtures are written with plain fs before any Effect runs.
// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { generateX25519Identity } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { HubServer } from "../Api.ts";
import { makeHub, type Hub, type HubConfig, type HubEvent } from "./Hub.ts";
import { discover } from "./OAuth.ts";
import { messagesInBody, toJson, type JsonRpcMessage } from "./JsonRpc.ts";
import { fakeAuthServer, fakeProtectedMcp, type FakeAuthServer, type FakeMcpServer } from "./testing/fakes.ts";
import { readBody } from "./Upstream.ts";

const RELAY_TOKEN = "relay-token-for-tests";
const stdioServer = new URL("./testing/fake-stdio-server.mjs", import.meta.url).pathname;

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | NodeServices.NodeServices | HttpClient.HttpClient>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));

let as: FakeAuthServer;
let mcp: FakeMcpServer;
let identity: string;

beforeAll(async () => {
  identity = await generateX25519Identity();
  as = await fakeAuthServer({ openIdOnly: true, expectedResource: () => `${mcp.url}/mcp` });
  mcp = await fakeProtectedMcp(() => as.url, (t) => as.isValid(t));
});
afterAll(async () => {
  await as.close();
  await mcp.close();
});

const fixture = (definitions: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "t3-fleet-hub-"));
  mkdirSync(join(dir, "repo/mcp"), { recursive: true });
  for (const [name, d] of Object.entries(definitions)) writeFileSync(join(dir, "repo/mcp", `${name}.json`), JSON.stringify(d));
  return dir;
};

const startHub = (dir: string, secrets: Record<string, string> = {}, overrides: Partial<HubConfig> = {}) =>
  Effect.gen(function* () {
    const events: Array<HubEvent> = [];
    const hub = yield* makeHub(
      {
        repo: join(dir, "repo"),
        home: dir,
        enabled: true,
        ports: {},
        relayUrl: "https://relay.example.test:8399",
        identity,
        relayToken: RELAY_TOKEN,
        version: "test",
        stateDir: join(dir, "state"),
        checkEvery: Duration.hours(1),
        allowLoopbackHttp: true,
        secrets: Effect.succeed(secrets),
        ...overrides,
      },
      (e) => Effect.sync(() => events.push(e)),
    );
    return { hub, events };
  });

const server = (hub: Hub, name: string) => hub.servers.pipe(Effect.map((all) => all.find((s) => s.name === name) as HubServer));

const waitFor = (hub: Hub, name: string, state: HubServer["state"]) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      const s = yield* server(hub, name);
      if (s?.state === state) return s;
      yield* Effect.sleep(Duration.millis(50));
    }
    return yield* Effect.die(new Error(`${name} never reached ${state}: ${toJson(yield* server(hub, name))}`));
  });

let nextId = 1;
const rpc = (hub: Hub, name: string, method: string, params: unknown, options: { readonly token?: string; readonly session?: string } = {}) =>
  Effect.gen(function* () {
    const response = yield* hub.gateway(name, `Bearer ${options.token ?? RELAY_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(options.session === undefined ? {} : { "mcp-session-id": options.session }) },
      body: toJson({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const text = yield* readBody(response);
    return { status: response.status, headers: response.headers, message: messagesInBody(response.headers["content-type"], text)[0] as JsonRpcMessage | undefined, text };
  });

describe("hub OAuth", () => {
  it("discovers, registers, signs in with PKCE, refreshes ahead of expiry and on 401, and asks for a login when refresh fails", async () => {
    const dir = fixture({ protected: { kind: "remote", url: `${mcp.url}/mcp`, transport: "streamable-http", remote_auth: true, remote_auth_scopes: ["mcp"], remote_auth_callback_port: 8666 } });
    await run(
      Effect.gen(function* () {
        const { hub, events } = yield* startHub(dir);
        const before = yield* waitFor(hub, "protected", "needs-login");
        expect(before.auth).toBe("oauth");

        // A call before signing in is refused with a clear state, never the upstream's 401.
        const refused = yield* rpc(hub, "protected", "tools/list", {});
        expect(refused.status).toBe(503);
        expect(refused.headers["x-t3-fleet-hub-state"]).toBe("needs-login");

        const url = new URL(yield* hub.login("protected"));
        expect(mcp.metadataHits().wellKnown).toBe(1);
        expect(url.searchParams.get("redirect_uri")).toBe("https://relay.example.test:8399/oauth/callback");
        expect(url.searchParams.get("resource")).toBe(`${mcp.url}/mcp`);
        expect(url.searchParams.get("scope")).toBe("mcp");
        expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(as.registrations()).toBe(1);

        // The state is checked: a forged or replayed callback fails.
        const code = as.approve(url.toString());
        expect((yield* hub.finishLogin({ code, state: "forged" }).pipe(Effect.flip))).toMatch(/unknown/);
        expect(yield* hub.finishLogin({ code, state: url.searchParams.get("state") ?? "" })).toBe("protected");
        expect((yield* hub.finishLogin({ code, state: url.searchParams.get("state") ?? "" }).pipe(Effect.flip))).toMatch(/unknown|already used/);
        expect(as.lastTokenRequest()?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{86}$/);

        const running = yield* waitFor(hub, "protected", "running");
        expect(running.tools).toBe(2);
        expect(running.expiresAt).toBeGreaterThan(yield* Clock.currentTimeMillis);
        expect(events.map((e) => e.state)).toContain("needs-login");
        expect(events.at(-1)?.state).toBe("running");

        // Tokens at rest are encrypted to the node's key.
        const sealed = readFileSync(join(dir, "state/tokens.age"), "utf8");
        expect(sealed).toContain("BEGIN AGE ENCRYPTED FILE");
        expect(sealed).not.toContain("at-");
        expect(sealed).not.toContain("rt-");

        // The upstream receives the messages the hub checked, re-serialized, not the raw body.
        const rawBody = '{"jsonrpc":"2.0", "id":77, "method":"tools/call", "params":{"name":"search","name":"search","arguments":{}}}';
        const sent = yield* hub.gateway("protected", `Bearer ${RELAY_TOKEN}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: rawBody });
        yield* readBody(sent);
        expect(mcp.lastBody()).toBe('{"jsonrpc":"2.0","id":77,"method":"tools/call","params":{"name":"search","arguments":{}}}');

        // Fresh tokens are not refreshed; tokens close to expiry are, once, even under concurrency.
        yield* hub.check("protected");
        expect(as.refreshes()).toBe(0);
        as.setExpiresIn(1);
        as.revokeAccessTokens(); // the next request gets a 401: one refresh, one retry
        const afterRevoke = yield* rpc(hub, "protected", "tools/call", { name: "search", arguments: { q: "secret query" } });
        expect(afterRevoke.message?.result).toMatchObject({ content: [{ text: "called search" }] });
        expect(as.refreshes()).toBe(1);
        // That refresh issued a token living one second; past its midpoint, concurrent calls refresh it once.
        yield* Effect.sleep(Duration.millis(700));
        const results = yield* Effect.all(
          Array.from({ length: 5 }, () => rpc(hub, "protected", "tools/call", { name: "search", arguments: {} })),
          { concurrency: 5 },
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(as.refreshes()).toBe(2);
        as.setExpiresIn(3600);

        // A refused refresh means a person must sign in again.
        as.revokeAccessTokens();
        as.refuseRefresh(true);
        const lost = yield* rpc(hub, "protected", "tools/list", {});
        expect(lost.status).toBe(503);
        expect((yield* server(hub, "protected")).state).toBe("needs-login");
        expect(events.at(-1)).toMatchObject({ server: "protected", state: "needs-login" });
        as.refuseRefresh(false);

        // The call log has methods and tools, never arguments or results.
        const calls = yield* hub.calls({ server: "protected", limit: 50 });
        expect(calls.some((c) => c.tool === "search" && c.outcome === "ok")).toBe(true);
        expect(calls.some((c) => c.outcome === "error" && c.error === "needs-login")).toBe(true);
        expect(toJson(calls)).not.toContain("secret query");
        expect(readFileSync(join(dir, "state/calls.jsonl"), "utf8")).not.toContain("secret query");
      }),
    );

    // Logins survive a restart of the hub; the dynamic registration is reused.
    await run(
      Effect.gen(function* () {
        const { hub } = yield* startHub(dir);
        const url = yield* hub.login("protected");
        expect(as.registrations()).toBe(1);
        yield* hub.finishLogin({ code: as.approve(url), state: new URL(url).searchParams.get("state") ?? "" });
        yield* waitFor(hub, "protected", "running");
        yield* hub.logout("protected");
        expect((yield* server(hub, "protected")).state).toBe("needs-login");
      }),
    );
  }, 30_000);

  it("detects a login from the server's 401 and follows its resource_metadata", async () => {
    const dir = fixture({ detected: { kind: "remote", url: `${mcp.url}/mcp` } });
    await run(
      Effect.gen(function* () {
        const { hub } = yield* startHub(dir);
        const s = yield* waitFor(hub, "detected", "needs-login");
        expect(s.auth).toBe("oauth");
        const hinted = mcp.metadataHits().hinted;
        const url = new URL(yield* hub.login("detected"));
        expect(mcp.metadataHits().hinted).toBe(hinted + 1);
        // No scopes in the definition: the resource's own scopes_supported are asked for.
        expect(url.searchParams.get("scope")).toBe("mcp");
        yield* hub.finishLogin({ code: as.approve(url.toString()), state: url.searchParams.get("state") ?? "" });
        yield* waitFor(hub, "detected", "running");
      }),
    );
  }, 30_000);
});

describe("hub OAuth validation", () => {
  const failure = (url: string, challenge: string | null, allowLoopbackHttp = true) =>
    run(discover(url, challenge, { allowLoopbackHttp }).pipe(Effect.flip, Effect.map((e) => e.message)));

  it("refuses plain HTTP unless explicitly allowed (tests only)", async () => {
    expect(await failure(`${mcp.url}/mcp`, null, false)).toMatch(/HTTPS/);
  });

  it("requires the metadata to name the issuer it was fetched for (RFC 8414 §3.3)", async () => {
    const liar = await fakeAuthServer({ openIdOnly: false, expectedResource: () => "", issuer: "https://evil.example" });
    const server = await fakeProtectedMcp(() => liar.url, () => false);
    try {
      expect(await failure(`${server.url}/mcp`, null)).toMatch(/different issuer/);
    } finally {
      await liar.close();
      await server.close();
    }
  });

  it("requires the resource metadata to be for this server (RFC 9728 §3.3)", async () => {
    const server = await fakeProtectedMcp(() => as.url, () => false, { resource: "https://other.example/mcp" });
    try {
      expect(await failure(`${server.url}/mcp`, null)).toMatch(/not http/);
    } finally {
      await server.close();
    }
  });

  it("follows a resource_metadata hint only on the server's own origin", async () => {
    const elsewhere = await fakeProtectedMcp(() => as.url, () => false);
    const server = await fakeProtectedMcp(() => as.url, () => false, { hint: `${elsewhere.url}/meta/resource` });
    try {
      const found = await run(discover(`${server.url}/mcp`, `Bearer resource_metadata="${elsewhere.url}/meta/resource"`, { allowLoopbackHttp: true }));
      expect(found.resource).toBe(`${server.url}/mcp`);
      expect(elsewhere.metadataHits()).toEqual({ wellKnown: 0, hinted: 0 });
      expect(server.metadataHits().wellKnown).toBe(1);
    } finally {
      await elsewhere.close();
      await server.close();
    }
  });

  it("never sends a static client's secret to an issuer the definition does not name", async () => {
    const dir = fixture({
      static: { kind: "remote", url: `${mcp.url}/mcp`, oauth: { client_id: "fixed", client_secret_env: "STATIC_SECRET", issuer: "https://auth.example" } },
    });
    await run(
      Effect.gen(function* () {
        const { hub } = yield* startHub(dir, { STATIC_SECRET: "do-not-leak" });
        yield* waitFor(hub, "static", "needs-login");
        const posts = as.tokenPosts();
        expect(yield* hub.login("static").pipe(Effect.flip)).toMatch(/names the issuer https:\/\/auth.example/);
        expect(as.tokenPosts()).toBe(posts);
      }),
    );
  });
});

describe("hub gateway", () => {
  it("bridges a stdio server, applies the tool policy, checks client tokens and logs calls", async () => {
    const dir = fixture({
      local: { kind: "hosted-stdio", command: process.execPath, args: [stdioServer], tools: { deny: ["delete_*"] } },
      other: { kind: "hosted-stdio", command: process.execPath, args: [stdioServer] },
      notes: { kind: "stdio", command: "notes" },
      broken: { kind: "registry" },
    });
    await run(
      Effect.gen(function* () {
        const { hub } = yield* startHub(dir);
        const local = yield* waitFor(hub, "local", "running");
        expect(local.tools).toBe(3);
        const all = yield* hub.servers;
        expect(all.map((s) => s.name)).toEqual(["broken", "local", "other"]);
        expect(all[0]).toMatchObject({ state: "error", detail: "registry definition has no image" });

        const init = yield* rpc(hub, "local", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
        const session = init.headers["mcp-session-id"] ?? "";
        expect(session).not.toBe("");

        const list = yield* rpc(hub, "local", "tools/list", {}, { session });
        const names = (list.message?.result as { tools: Array<{ name: string }> } | undefined)?.tools.map((t) => t.name);
        expect(names).toEqual(["echo", "notify", "crash"]);

        const denied = yield* rpc(hub, "local", "tools/call", { name: "delete_all", arguments: {} }, { session });
        expect(denied.message?.error).toMatchObject({ code: -32003 });

        const echoed = yield* rpc(hub, "local", "tools/call", { name: "echo", arguments: { text: "private words" } }, { session });
        expect(echoed.message?.result).toMatchObject({ content: [{ text: "private words (init 1)" }] });

        // Client tokens: hashed, limited to servers, revocable.
        const token = yield* hub.createToken("laptop", ["local"]);
        expect(token).toMatch(/^fxh_/);
        expect(readFileSync(join(dir, "state/tokens.age"), "utf8")).not.toContain(token);
        // A session belongs to the client that opened it.
        expect((yield* rpc(hub, "local", "ping", {}, { token, session })).status).toBe(404);
        const own = (yield* rpc(hub, "local", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "l", version: "1" } }, { token })).headers["mcp-session-id"] ?? "";
        expect((yield* rpc(hub, "local", "ping", {}, { token, session: own })).status).toBe(200);
        expect((yield* rpc(hub, "local", "ping", {}, { session: own })).status).toBe(404);
        expect((yield* rpc(hub, "other", "ping", {}, { token })).status).toBe(403);
        expect((yield* rpc(hub, "local", "ping", {}, { token: "wrong" })).status).toBe(401);
        expect((yield* hub.listTokens).map((t) => t.client)).toEqual(["laptop"]);
        expect(yield* hub.revokeToken("laptop")).toBe(true);
        expect((yield* rpc(hub, "local", "ping", {}, { token, session: own })).status).toBe(401);
        expect((yield* hub.createToken("relay", null).pipe(Effect.flip))).toMatch(/not "relay"/);

        const calls = yield* hub.calls({ server: "local" });
        const outcome = (method: string, tool: string | null) => calls.find((c) => c.method === method && c.tool === tool)?.outcome;
        expect(outcome("tools/call", "delete_all")).toBe("denied");
        expect(outcome("tools/call", "echo")).toBe("ok");
        // A rejected request is one record, with only its HTTP method: its body is never read.
        expect(calls.filter((c) => c.outcome === "unauthorized").map((c) => [c.client, c.method, c.tool])).toEqual([
          ["unknown", "POST", null],
          ["unknown", "POST", null],
        ]);
        expect(calls.filter((c) => c.method === "ping").map((c) => [c.client, c.outcome])).toEqual([["laptop", "ok"]]);
        expect(toJson(calls)).not.toContain("private words");

        // Keys differing only in case are refused; exact duplicates are read (last wins) and checked as read.
        const raw = (body: string) =>
          hub.gateway("local", `Bearer ${RELAY_TOKEN}`, { method: "POST", headers: { "content-type": "application/json", "mcp-session-id": session }, body }).pipe(
            Effect.flatMap((r) => readBody(r).pipe(Effect.map((text) => ({ status: r.status, text })))),
          );
        const variant = yield* raw('{"jsonrpc":"2.0","id":50,"method":"tools/call","params":{"name":"echo","Name":"delete_all","arguments":{}}}');
        expect(variant.status).toBe(400);
        expect(variant.text).toContain("differ only in case");
        expect((yield* raw('{"jsonrpc":"2.0","id":51,"Method":"tools/call","method":"ping"}')).status).toBe(400);
        const duplicate = yield* raw('{"jsonrpc":"2.0","id":52,"method":"tools/call","params":{"name":"echo","name":"delete_all","arguments":{}}}');
        expect(duplicate.text).toContain("-32003");
        expect((yield* raw('{"jsonrpc":"2.0","id":53,"method":"tools/call","params":{"name":7}}')).status).toBe(400);
        const long = yield* rpc(hub, "local", "tools/call", { name: "x".repeat(300), arguments: {} }, { session });
        expect(long.message?.error).toMatchObject({ code: -32003 });

        // Errors are logged by code, never by the server's message.
        yield* rpc(hub, "local", "resources/read", { uri: "secret://echoed" }, { session });

        const after = yield* hub.calls({ server: "local", limit: 100 });
        expect(after.find((c) => c.method === "resources/read")).toMatchObject({ outcome: "error", error: "JSON-RPC error -32601" });
        expect(after.every((c) => c.method.length <= 128 && (c.tool ?? "").length <= 128)).toBe(true);
        expect(toJson(after)).not.toContain("unknown method");

        // Unknown servers are 404; the stdio-kind definition is not hosted.
        const missing = yield* hub.gateway("notes", `Bearer ${RELAY_TOKEN}`, { method: "POST", headers: {}, body: "{}" });
        expect(missing.status).toBe(404);
        yield* missing.body.pipe(Stream.runDrain, Effect.ignore);
      }),
    );
  }, 30_000);

  it("refuses a session it has no owner for, and forgets a session once it is deleted", async () => {
    const plain = await fakeProtectedMcp(() => as.url, () => true);
    try {
      const dir = fixture({});
      await run(
        Effect.gen(function* () {
          const { hub } = yield* startHub(dir, {}, { ports: { plain: Number(new URL(plain.url).port) } });
          yield* waitFor(hub, "plain", "running");
          expect((yield* rpc(hub, "plain", "tools/list", {}, { session: "made-up" })).status).toBe(404);
          const session = (yield* rpc(hub, "plain", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).headers["mcp-session-id"] ?? "";
          expect(session).toBe("s-1");
          const token = yield* hub.createToken("laptop", null);
          expect((yield* rpc(hub, "plain", "tools/list", {}, { token, session })).status).toBe(404);
          expect((yield* rpc(hub, "plain", "tools/list", {}, { session })).status).toBe(200);
          const deleted = yield* hub.gateway("plain", `Bearer ${RELAY_TOKEN}`, { method: "DELETE", headers: { "mcp-session-id": session }, body: "" });
          expect(deleted.status).toBe(204);
          // The proxy fails reading a 204's empty body (Upstream.ts); only the status matters here.
          yield* readBody(deleted).pipe(Effect.ignore);
          expect((yield* rpc(hub, "plain", "tools/list", {}, { session })).status).toBe(404);
        }),
      );
    } finally {
      await plain.close();
    }
  }, 30_000);
});

describe("hub health checks", () => {
  it("keeps checking when a server answers nonsense, and restarts one that stops answering", async () => {
    const dir = fixture({
      nonsense: { kind: "hosted-stdio", command: process.execPath, args: [stdioServer, "--null-tools"] },
      fine: { kind: "hosted-stdio", command: process.execPath, args: [stdioServer] },
      silent: { kind: "hosted-stdio", command: process.execPath, args: [stdioServer, "--silent-tools"] },
    });
    await run(
      Effect.gen(function* () {
        const { hub, events } = yield* startHub(dir, {}, { checkEvery: Duration.millis(300) });
        const fine = yield* waitFor(hub, "fine", "running");
        const nonsense = yield* waitFor(hub, "nonsense", "error");
        expect(nonsense.detail).toMatch(/tools\/list/);
        yield* Effect.sleep(Duration.millis(1500));
        expect((yield* server(hub, "fine")).lastCheckAt).toBeGreaterThan(fine.lastCheckAt ?? Infinity);
        // A definition added later is still picked up.
        writeFileSync(join(dir, "repo/mcp", "later.json"), toJson({ kind: "hosted-stdio", command: process.execPath, args: [stdioServer] }));
        yield* waitFor(hub, "later", "running");
        // Three checks without an answer: the process is started again.
        const silent = events.filter((e) => e.server === "silent").map((e) => e.state);
        expect(silent.slice(silent.indexOf("error"))).toContain("starting");
      }),
    );
  }, 30_000);
});
