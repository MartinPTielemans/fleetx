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
import { makeHub, type Hub, type HubEvent } from "./Hub.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "fleetx-hub-"));
  mkdirSync(join(dir, "repo/mcp"), { recursive: true });
  for (const [name, d] of Object.entries(definitions)) writeFileSync(join(dir, "repo/mcp", `${name}.json`), JSON.stringify(d));
  return dir;
};

const startHub = (dir: string, secrets: Record<string, string> = {}) =>
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
        secrets: Effect.succeed(secrets),
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
        expect(refused.headers["x-fleetx-hub-state"]).toBe("needs-login");

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
        const names = (list.message?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
        expect(names).toEqual(["echo", "notify", "crash"]);

        const denied = yield* rpc(hub, "local", "tools/call", { name: "delete_all", arguments: {} }, { session });
        expect(denied.message?.error).toMatchObject({ code: -32003 });

        const echoed = yield* rpc(hub, "local", "tools/call", { name: "echo", arguments: { text: "private words" } }, { session });
        expect(echoed.message?.result).toMatchObject({ content: [{ text: "private words (init 1)" }] });

        // Client tokens: hashed, limited to servers, revocable.
        const token = yield* hub.createToken("laptop", ["local"]);
        expect(token).toMatch(/^fxh_/);
        expect(readFileSync(join(dir, "state/tokens.age"), "utf8")).not.toContain(token);
        expect((yield* rpc(hub, "local", "ping", {}, { token, session })).status).toBe(200);
        expect((yield* rpc(hub, "other", "ping", {}, { token })).status).toBe(403);
        expect((yield* rpc(hub, "local", "ping", {}, { token: "wrong" })).status).toBe(401);
        expect((yield* hub.listTokens).map((t) => t.client)).toEqual(["laptop"]);
        expect(yield* hub.revokeToken("laptop")).toBe(true);
        expect((yield* rpc(hub, "local", "ping", {}, { token, session })).status).toBe(401);
        expect((yield* hub.createToken("relay", null).pipe(Effect.flip))).toMatch(/not "relay"/);

        const calls = yield* hub.calls({ server: "local" });
        const outcome = (method: string, tool: string | null) => calls.find((c) => c.method === method && c.tool === tool)?.outcome;
        expect(outcome("tools/call", "delete_all")).toBe("denied");
        expect(outcome("tools/call", "echo")).toBe("ok");
        expect(calls.filter((c) => c.method === "ping").map((c) => [c.client, c.outcome])).toEqual([
          ["unknown", "unauthorized"],
          ["unknown", "unauthorized"],
          ["laptop", "ok"],
        ]);
        expect(toJson(calls)).not.toContain("private words");

        // Unknown servers are 404; the stdio-kind definition is not hosted.
        const missing = yield* hub.gateway("notes", `Bearer ${RELAY_TOKEN}`, { method: "POST", headers: {}, body: "{}" });
        expect(missing.status).toBe(404);
        yield* missing.body.pipe(Stream.runDrain, Effect.ignore);
      }),
    );
  }, 30_000);
});
