import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { HubServer, UiApplyResult, UiModels, UiStatus } from "./Api.ts";
import type { Node } from "./Config.ts";
import type { Finding, Fix } from "./Diagnose.ts";
import type { MachineObservation } from "./Observation.ts";
import { mergeLayers } from "./Settings.ts";
import { refusal, uiLayer, type UiActions, type UiCheck } from "./UiServer.ts";

const PORT = 8397;
const TOKEN = "a".repeat(48);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const node = (name: string): Node => ({ name, ssh: name === "laptop" ? null : name, roles: ["member"], profiles: [], tailnet: null, settings: mergeLayers([]) });

const observation: MachineObservation = {
  protocol: 4,
  hostname: "laptop",
  platform: "darwin",
  arch: "arm64",
  user: "me",
  observedAt: 1_000,
  agents: [{ name: "claude", managedPath: "~/.local/bin/claude", managedVersion: "2.1.0", onPath: [] }],
  t3: {
    runtime: null,
    descriptor: { environmentId: "e", label: "laptop", serverVersion: "0.0.46-nightly.20261003.2623" },
    installedVersion: null,
    runtimeBinary: null,
    serverPath: null,
    providers: [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        binaryPath: "~/.local/bin/fleetx-claude",
        resolved: "~/.local/bin/fleetx-claude",
        launch: { ok: true, version: "2.1.0", detail: "" },
      },
    ],
    problems: [],
  },
  proxy: null,
  areas: { models: { claude: { loggedIn: true, method: "setup-token", detail: "" } } },
  legacySync: null,
};

const upgrade: Finding & { fix: Fix } = {
  node: "laptop",
  key: "claude-behind",
  severity: "warn",
  area: "agents",
  title: "claude 2.1.0 is behind 2.1.1",
  fix: { command: "npm i -g @anthropic-ai/claude-code@2.1.1", safe: true },
};

const fakeCheck = (findings: ReadonlyArray<Finding>): UiCheck => ({
  report: {
    results: [
      { node: node("laptop"), ok: true, observation, ms: 10 },
      { node: node("server"), ok: false, error: "ssh server failed: unreachable", ms: 10 },
    ],
    latest: { agents: { claude: "2.1.1", codex: null }, t3: { nightly: { versions: ["0.0.46-nightly.20261003.2623"] } } },
    findings,
    elapsedMs: 1200,
  },
  states: [],
  accepted: [{ id: "server:noted", reason: "on purpose" }],
});

/** A fleet whose one finding goes away once its fix has run; records every fix it is asked to run. */
const fakeFleet = () => {
  const applied: Array<string> = [];
  let fixed = false;
  const accepted: Finding = { node: "server", key: "noted", severity: "info", area: "parity", title: "a deliberate difference", detail: "accepted: on purpose" };
  const actions: UiActions = {
    check: Effect.sync(() => fakeCheck(fixed ? [accepted] : [upgrade, accepted])),
    apply: (fixes) =>
      Effect.sync(() => {
        applied.push(...fixes.map((f) => `${f.node}:${f.key}`));
        fixed = true;
        return fixes.map((finding) => ({ finding, ok: true, summary: "upgraded" }));
      }),
    proposals: Effect.succeed([]),
    approve: () => Effect.void,
    reject: (node) => Effect.fail(`no proposal from ${node}`),
    alerts: Effect.succeed([{ at: 5, node: "server", kind: "failing", message: "sync failed" }]),
    config: (name) => (name === "laptop" ? Effect.succeed([{ path: "a.b", value: "1", source: "defaults" }]) : Effect.fail(`unknown machine: ${name}`)),
  };
  return { actions, applied };
};

/** The relay, as far as the hub endpoints go. */
const relayClient = (hub: boolean) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, url) => {
      const reply = (status: number, body: string) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body === "" ? null : body, { status })));
      if (request.headers["authorization"] !== "Bearer relay-token") return reply(401, "Unauthorized");
      if (!hub) return reply(404, "Not Found");
      if (url.pathname === "/hub/servers") {
        const server: HubServer = { name: "linear", kind: "remote", upstream: "https://mcp.example/mcp", state: "needs-login", detail: null, auth: "oauth", expiresAt: null, tools: null, lastCheckAt: null };
        return reply(200, JSON.stringify([server]));
      }
      if (url.pathname === "/hub/servers/linear/login") return reply(200, JSON.stringify({ url: "https://auth.example/authorize" }));
      if (url.pathname === "/hub/servers/linear/restart") return reply(204, "");
      if (url.pathname === "/hub/calls") return reply(200, JSON.stringify([{ nope: true }]));
      return reply(404, "Not Found");
    }),
  );

const serve = (options: { readonly hub?: boolean; readonly relay?: boolean } = {}) => {
  const fleet = fakeFleet();
  const assets = new Map([
    ["/index.html", { type: "text/html; charset=utf-8", body: new TextEncoder().encode("<!doctype html><title>fleetx</title>") }],
    ["/assets/app-1.js", { type: "text/javascript; charset=utf-8", body: new TextEncoder().encode("console.log(1)") }],
  ]);
  const { handler, dispose } = HttpRouter.toWebHandler(
    uiLayer({
      token: TOKEN,
      port: PORT,
      assets,
      session: { version: "0.0.0", self: "laptop", authority: true, nodes: ["laptop", "server"], relay: options.relay === false ? null : "https://relay.example" },
      actions: fleet.actions,
      relay: options.relay === false ? null : { url: "https://relay.example", token: "relay-token" },
    }).pipe(Layer.provide(relayClient(options.hub ?? true))),
    { disableLogger: true },
  );
  const call = (path: string, init: RequestInit & { readonly token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", `127.0.0.1:${PORT}`);
    if (init.token !== null) headers.set("x-fleetx-token", init.token ?? TOKEN);
    return handler(new Request(`${ORIGIN}${path}`, { ...init, headers }));
  };
  return { call, dispose, applied: fleet.applied };
};

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, text: string) => Schema.decodeSync(Schema.fromJsonString(schema))(text);

describe("refusal", () => {
  const options = { port: PORT, token: TOKEN };
  const none = new URLSearchParams();
  const ok = { "host": `127.0.0.1:${PORT}`, "x-fleetx-token": TOKEN };

  it("lets this run's own page through", () => {
    expect(refusal({ method: "POST", headers: { ...ok, origin: ORIGIN } }, options, none)).toBeNull();
    expect(refusal({ method: "GET", headers: { ...ok, host: `localhost:${PORT}` } }, options, none)).toBeNull();
  });

  it("refuses other websites", () => {
    expect(refusal({ method: "POST", headers: { ...ok, origin: "https://evil.example" } }, options, none)?.status).toBe(403);
    expect(refusal({ method: "POST", headers: { ...ok, origin: `http://127.0.0.1:${PORT + 1}` } }, options, none)?.status).toBe(403);
    expect(refusal({ method: "POST", headers: { ...ok, origin: "null" } }, options, none)?.status).toBe(403);
  });

  it("refuses a rebound host name, even with the token", () => {
    expect(refusal({ method: "GET", headers: { ...ok, host: `evil.example:${PORT}` } }, options, none)?.status).toBe(421);
    expect(refusal({ method: "GET", headers: { "x-fleetx-token": TOKEN } }, options, none)?.status).toBe(421);
  });

  it("needs the token, as a header or in the query", () => {
    expect(refusal({ method: "GET", headers: { host: ok.host } }, options, none)?.status).toBe(401);
    expect(refusal({ method: "GET", headers: { host: ok.host, "x-fleetx-token": "b".repeat(48) } }, options, none)?.status).toBe(401);
    expect(refusal({ method: "GET", headers: { host: ok.host } }, options, new URLSearchParams({ token: TOKEN }))).toBeNull();
  });

  it("serves the app itself without a token, to loopback hosts only", () => {
    expect(refusal({ method: "GET", headers: { host: ok.host } }, { port: PORT, token: null }, none)).toBeNull();
    expect(refusal({ method: "GET", headers: { host: "evil.example" } }, { port: PORT, token: null }, none)?.status).toBe(421);
  });
});

describe("the UI server", () => {
  const server = serve();
  afterAll(() => server.dispose());

  it("guards every /api route", async () => {
    expect((await server.call("/api/status", { token: null })).status).toBe(401);
    expect((await server.call("/api/fixes", { method: "POST", body: '{"ids":[]}', headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await server.call("/api/status", { headers: { host: "evil.example:8397" } })).status).toBe(421);
    expect((await server.call("/api/nothing")).status).toBe(404);
    expect((await server.call("/api/nothing", { token: null })).status).toBe(401);
  });

  it("serves the check as UiStatus", async () => {
    const response = await server.call("/api/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const status = decode(UiStatus, await response.text());
    expect(status.environments.map((e) => [e.name, e.reachable])).toEqual([
      ["laptop", true],
      ["server", false],
    ]);
    const laptop = status.environments[0];
    expect(laptop?.t3).toEqual({ version: "0.0.46-nightly.20261003.2623", channel: "nightly", behind: 0 });
    expect(laptop?.agents).toEqual([{ name: "claude", version: "2.1.0", latest: "2.1.1" }]);
    expect(laptop?.providers[0]?.viaModels).toBe(true);
    expect(laptop?.claude).toEqual({ loggedIn: true, method: "setup-token", detail: "" });
    expect(status.environments[1]?.error).toBe("ssh server failed: unreachable");
    expect(status.findings.map((f) => f.id)).toEqual(["laptop:claude-behind", "server:noted"]);
    expect(status.findings[1]).toMatchObject({ severity: "info", accepted: "on purpose" });
    expect(status.findings[1]?.detail).toBeUndefined();
    expect(status.summary).toContain("laptop");
  });

  it("serves models, alerts and config", async () => {
    const models = decode(UiModels, await (await server.call("/api/models")).text());
    expect(models.nodes.map((n) => [n.node, n.claude?.loggedIn ?? null])).toEqual([
      ["laptop", true],
      ["server", null],
    ]);
    expect(await (await server.call("/api/alerts")).json()).toEqual([{ at: 5, node: "server", kind: "failing", message: "sync failed" }]);
    expect(await (await server.call("/api/config/laptop")).json()).toEqual([{ path: "a.b", value: "1", source: "defaults" }]);
    expect((await server.call("/api/config/nowhere")).status).toBe(404);
    expect((await server.call("/api/config/..%2F..")).status).toBe(400);
  });

  it("reports a failed proposal decision", async () => {
    expect((await server.call("/api/proposals/server/approve", { method: "POST" })).status).toBe(204);
    const rejected = await server.call("/api/proposals/server/reject", { method: "POST" });
    expect(rejected.status).toBe(409);
    expect(await rejected.text()).toBe("no proposal from server");
  });

  it("applies only fixes the fresh check still proposes, then checks again", async () => {
    const response = await server.call("/api/fixes", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ids: ["laptop:claude-behind", "server:noted", "laptop:made-up"] }),
    });
    expect(response.status).toBe(200);
    const result = decode(UiApplyResult, await response.text());
    expect(server.applied).toEqual(["laptop:claude-behind"]);
    expect(result.results).toEqual([{ id: "laptop:claude-behind", node: "laptop", title: upgrade.title, ok: true, output: "upgraded" }]);
    expect(result.notApplied).toEqual([
      { id: "server:noted", reason: "this finding has no automatic fix" },
      { id: "laptop:made-up", reason: "no longer found; it may already be fixed" },
    ]);
    expect(result.status.findings.map((f) => f.id)).toEqual(["server:noted"]);

    const again = decode(UiApplyResult, await (await server.call("/api/fixes", { method: "POST", body: JSON.stringify({ ids: ["laptop:claude-behind"] }) })).text());
    expect(again.results).toEqual([]);
    expect(server.applied).toEqual(["laptop:claude-behind"]);
    expect((await server.call("/api/fixes", { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("passes the hub through with the relay token, and checks its answers", async () => {
    const servers = await server.call("/api/hub/servers");
    expect(servers.status).toBe(200);
    expect(await servers.json()).toMatchObject([{ name: "linear", state: "needs-login" }]);
    expect(await (await server.call("/api/hub/servers/linear/login", { method: "POST" })).json()).toEqual({ url: "https://auth.example/authorize" });
    expect((await server.call("/api/hub/servers/linear/restart", { method: "POST" })).status).toBe(204);
    expect((await server.call("/api/hub/calls")).status).toBe(502);
    expect((await server.call("/api/hub/servers/..%2Fx/logout", { method: "POST" })).status).toBe(400);
  });

  it("serves the app, with an index for every view and no framing", async () => {
    const index = await server.call("/", { token: null });
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("x-frame-options")).toBe("DENY");
    expect(index.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await index.text()).toContain("<title>fleetx</title>");
    expect(await (await server.call("/findings", { token: null })).text()).toContain("<title>fleetx</title>");
    const asset = await server.call("/assets/app-1.js", { token: null });
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await server.call("/assets/missing.js", { token: null })).status).toBe(404);
    expect((await server.call("/", { token: null, headers: { host: "evil.example" } })).status).toBe(421);
  });
});

describe("the UI server without the hub", () => {
  it("says the relay has no hub", async () => {
    const server = serve({ hub: false });
    const response = await server.call("/api/hub/servers");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("the relay has no hub");
    await server.dispose();
  });

  it("says the fleet has no relay", async () => {
    const server = serve({ relay: false });
    expect((await server.call("/api/hub/servers")).status).toBe(503);
    await server.dispose();
  });
});
