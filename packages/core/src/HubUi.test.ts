// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { describe, expect, it } from "vite-plus/test";

import { UiJob, UiSession, UiSessionGrant, UiStatus } from "./Api.ts";
import type { Node } from "./Config.ts";
import type { Finding, Fix } from "./Diagnose.ts";
import {
  connectionOf,
  decodeHeaderValue,
  identify,
  refusedPage,
  servedByTailscale,
  socketOwner,
  tailscaledUid,
  type HubGate,
} from "./HubUi.ts";
import { mergeLayers } from "./Settings.ts";
import { uiLayer, type UiActions } from "./UiServer.ts";

const URL_ = "https://box.tailnet.ts.net:8399";
const HOST = "box.tailnet.ts.net:8399";
const gate: HubGate = { url: URL_, allow: ["Me@Example.com"] };
const through = (headers: Record<string, string>, remoteAddress: string | null = "127.0.0.1") => ({
  headers: { host: HOST, ...headers },
  remoteAddress,
});

describe("identify", () => {
  it("lets an allowed login in through the local tailscale proxy, without regard to case", () => {
    expect(identify(through({ "tailscale-user-login": "me@example.com" }), gate)).toEqual({
      ok: true,
      login: "me@example.com",
    });
    expect(
      identify(through({ "tailscale-user-login": "me@example.com" }, "::ffff:127.0.0.1"), gate).ok,
    ).toBe(true);
    expect(
      identify(through({ "tailscale-user-login": "me@example.com", origin: URL_ }), gate).ok,
    ).toBe(true);
  });

  it("refuses a direct connection that brings its own identity headers", () => {
    for (const peer of ["100.101.102.103", "172.17.0.3", "::1x", null]) {
      const who = identify(through({ "tailscale-user-login": "me@example.com" }, peer), gate);
      expect(who).toMatchObject({ ok: false, status: 403, title: "Not through Tailscale" });
    }
  });

  it("refuses a login not in [ui] allow, and says which login it saw", () => {
    const who = identify(through({ "tailscale-user-login": "mallory@example.com" }), gate);
    expect(who).toMatchObject({ ok: false, status: 403, login: "mallory@example.com" });
    expect(
      identify(through({ "tailscale-user-login": "me@example.com" }), { url: URL_, allow: [] }),
    ).toMatchObject({
      ok: false,
      status: 403,
      message: "No login may open the app on this hub yet.",
    });
  });

  it("refuses another origin, another host, Funnel, and a request with no login", () => {
    const login = { "tailscale-user-login": "me@example.com" };
    expect(identify(through({ ...login, origin: "https://evil.example" }), gate)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(
      identify(through({ ...login, origin: "http://box.tailnet.ts.net:8399" }), gate),
    ).toMatchObject({ ok: false, status: 403 });
    expect(identify(through({ ...login, host: "evil.example:8399" }), gate)).toMatchObject({
      ok: false,
      status: 421,
    });
    expect(identify(through({ "tailscale-funnel-request": "?1" }), gate)).toMatchObject({
      ok: false,
      status: 403,
      title: "Not on the internet",
    });
    // A tagged device: Tailscale sets no login at all.
    expect(identify(through({}), gate)).toMatchObject({ ok: false, status: 401, login: null });
  });

  it("reads a login Tailscale had to encode", () => {
    expect(decodeHeaderValue("=?utf-8?q?zo=C3=AB@example.com?=")).toBe("zoë@example.com");
    expect(decodeHeaderValue("plain@example.com")).toBe("plain@example.com");
    expect(
      identify(through({ "tailscale-user-login": "=?utf-8?q?zo=C3=AB@example.com?=" }), {
        url: URL_,
        allow: ["zoë@example.com"],
      }).ok,
    ).toBe(true);
  });

  it("explains a refusal in a page that names the login and the setting, escaped", () => {
    const who = identify(through({ "tailscale-user-login": "<b>x</b>@example.com" }), gate);
    if (who.ok) throw new Error("should be refused");
    const page = refusedPage(who);
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;@example.com");
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("[ui]");
    expect(page).toContain("t3-fleet.toml");
  });
});

// ── the server, served by the hub ──────────────────────────────────────

const node = (name: string, roles: Node["roles"]): Node => ({
  name,
  ssh: null,
  roles,
  profiles: [],
  tailnet: null,
  settings: mergeLayers([]),
});

const upgrade: Finding & { fix: Fix } = {
  node: "laptop",
  key: "claude-behind",
  severity: "warn",
  area: "agents",
  title: "claude 2.1.0 is behind 2.1.1",
  fix: { command: "npm i -g @anthropic-ai/claude-code@2.1.1", safe: true },
};

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) => Schema.decodeSync(Schema.fromJsonString(schema))(text);

const serveOnHub = () => {
  const decided: Array<string> = [];
  const steps: Array<string> = [];
  const applied: Array<string> = [];
  const actions: UiActions = {
    check: Effect.succeed({
      report: {
        results: [{ node: node("laptop", ["authority"]), ok: false, error: "not reported", ms: 0 }],
        latest: { agents: { claude: null, codex: null }, t3: {} },
        findings: [upgrade],
        elapsedMs: 0,
      },
      states: [],
      accepted: [],
    }),
    apply: (fixes, step) =>
      step("sent to laptop").pipe(
        Effect.andThen(
          Effect.sync(() => {
            applied.push(...fixes.map((f) => `${f.node}:${f.key}`));
            return fixes.map((finding) => ({ finding, ok: true, summary: "upgraded" }));
          }),
        ),
      ),
    proposals: Effect.succeed([]),
    approve: (n) => Effect.sync(() => (decided.push(n), [])),
    reject: (n) => Effect.sync(() => void decided.push(n)),
    alerts: Effect.succeed([]),
    config: () => Effect.succeed([]),
    skills: {
      list: Effect.succeed([]),
      lookup: (url) => Effect.succeed({ url, skills: [] }),
      add: () => Effect.fail("no"),
      preview: () => Effect.fail("no"),
      update: () => Effect.fail("no"),
      remove: () => Effect.fail("no"),
    },
  };
  const { handler, dispose } = HttpRouter.toWebHandler(
    uiLayer({
      ticket: "t".repeat(48),
      port: 8399,
      assets: new Map([
        [
          "/index.html",
          { type: "text/html", body: new TextEncoder().encode("<title>app</title>") },
        ],
      ]),
      session: {
        version: "0.0.0",
        self: "box",
        authority: true,
        nodes: ["laptop", "box"],
        relay: URL_,
      },
      actions,
      relay: null,
      hub: {
        gate: Effect.succeed({ url: URL_, allow: ["Me@Example.com", "you@example.com"] }),
        approveOn: Effect.succeed(["laptop"]),
        // A test's stand-in for who made the connection: tailscale serve, unless it says otherwise.
        servedBy: (request) =>
          Effect.succeed(
            request.headers["x-test-made-by"] === undefined
              ? null
              : "This request did not come through tailscale serve: another program on the hub made it.",
          ),
      },
    }).pipe(Layer.provide(FetchHttpClient.layer)),
    {
      disableLogger: true,
      // A test's stand-in for the connection's peer, which a web Request does not have.
      middleware: (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const peer = request.headers["x-test-peer"] ?? "127.0.0.1";
          return yield* app.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({ remoteAddress: Option.some(peer) }),
            ),
          );
        }),
    },
  );
  const raw = (path: string, init: RequestInit = {}, login: string | null = "me@example.com") => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", HOST);
    if (login !== null) headers.set("tailscale-user-login", login);
    return handler(new Request(`${URL_}${path}`, { ...init, headers }));
  };
  const grant = async (login = "me@example.com") => {
    const r = await raw(
      "/api/session",
      { method: "POST", headers: { "x-t3-fleet-hub": "1" } },
      login,
    );
    expect(r.status).toBe(200);
    return decode(UiSessionGrant, await r.text()).token;
  };
  return { raw, grant, decided, steps, applied, dispose };
};

describe("the app on the hub", () => {
  it("serves the app only to an allowed login, and a refused one a page that says why", async () => {
    const hub = serveOnHub();
    const ok = await hub.raw("/");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("<title>app</title>");
    const stranger = await hub.raw("/", {}, "mallory@example.com");
    expect(stranger.status).toBe(403);
    expect(stranger.headers.get("content-type")).toContain("text/html");
    const page = await stranger.text();
    expect(page).toContain("mallory@example.com");
    expect(page).toContain("allow = [&quot;mallory@example.com&quot;]");
    expect((await hub.raw("/", {}, null)).status).toBe(401);
    // Spoofed headers on a connection that did not come through the local proxy.
    expect((await hub.raw("/", { headers: { "x-test-peer": "100.64.0.9" } })).status).toBe(403);
    await hub.dispose();
  });

  it("hands a token to a login it lets in, bound to that login", async () => {
    const hub = serveOnHub();
    // A form on another site cannot set the header, nor pass the Origin check.
    expect((await hub.raw("/api/session", { method: "POST" })).status).toBe(400);
    expect(
      (
        await hub.raw("/api/session", {
          method: "POST",
          headers: { "x-t3-fleet-hub": "1", origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await hub.raw(
          "/api/session",
          { method: "POST", headers: { "x-t3-fleet-hub": "1" } },
          "mallory@example.com",
        )
      ).status,
    ).toBe(403);
    const token = await hub.grant();
    const status = await hub.raw("/api/status", { headers: { "x-t3-fleet-token": token } });
    expect(status.status).toBe(200);
    expect(decode(UiStatus, await status.text()).findings[0]?.id).toBe("laptop:claude-behind");
    // Without the token, or with it from a direct connection, or for someone else: refused.
    expect((await hub.raw("/api/status")).status).toBe(401);
    expect(
      (
        await hub.raw("/api/status", {
          headers: { "x-t3-fleet-token": token, "x-test-peer": "10.0.0.2" },
        })
      ).status,
    ).toBe(403);
    const session = decode(
      UiSession,
      await (await hub.raw("/api/session", { headers: { "x-t3-fleet-token": token } })).text(),
    );
    expect(session.hub).toEqual({ login: "me@example.com", approveOn: ["laptop"] });
    await hub.dispose();
  });

  it("refuses a token handed to another login", async () => {
    const hub = serveOnHub();
    const token = await hub.grant("me@example.com");
    const other = await hub.raw(
      "/api/status",
      { headers: { "x-t3-fleet-token": token } },
      "you@example.com",
    );
    expect(other.status).toBe(401);
    expect((await hub.raw("/api/status", { headers: { "x-t3-fleet-token": token } })).status).toBe(
      200,
    );
    await hub.dispose();
  });

  it("never approves or rejects a proposal, even on an authority", async () => {
    const hub = serveOnHub();
    const token = await hub.grant();
    for (const verb of ["approve", "reject"]) {
      const r = await hub.raw(`/api/proposals/laptop/${verb}`, {
        method: "POST",
        headers: { "x-t3-fleet-token": token },
        body: JSON.stringify({ change: "e".repeat(64) }),
      });
      expect(r.status).toBe(403);
      expect(await r.text()).toContain("on an authority (laptop)");
    }
    expect(hub.decided).toEqual([]);
    await hub.dispose();
  });

  it("applies a fix as a job whose steps come from the machine it runs on", async () => {
    const hub = serveOnHub();
    const token = await hub.grant();
    const headers = { "x-t3-fleet-token": token };
    const plan = await hub.raw("/api/fixes/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: ["laptop:claude-behind"] }),
    });
    const digest = (JSON.parse(await plan.text()) as { fixes: Array<{ digest: string }> }).fixes[0]
      ?.digest;
    const started = await hub.raw("/api/fixes", {
      method: "POST",
      headers,
      body: JSON.stringify({ fixes: [{ id: "laptop:claude-behind", digest }], acknowledged: [] }),
    });
    expect(started.status).toBe(202);
    const id = decode(UiJob, await started.text()).id;
    let job: typeof UiJob.Type | undefined;
    for (let i = 0; i < 200 && job?.state !== "done"; i++) {
      await Effect.runPromise(Effect.sleep(10));
      const jobs = decode(
        Schema.Array(UiJob),
        await (await hub.raw("/api/jobs", { headers })).text(),
      );
      job = jobs.find((j) => j.id === id);
    }
    expect(job?.state).toBe("done");
    expect(job?.applied?.results).toMatchObject([{ id: "laptop:claude-behind", ok: true }]);
    expect(hub.applied).toEqual(["laptop:claude-behind"]);
    await hub.dispose();
  });
});

describe("a program on the hub posing as tailscale serve (review A-G)", () => {
  it("gets no session and no app, whatever login it names", async () => {
    const hub = serveOnHub();
    try {
      const forged = { "x-test-made-by": "a local program", "x-t3-fleet-hub": "1" };
      const session = await hub.raw("/api/session", { method: "POST", headers: forged });
      expect(session.status).toBe(403);
      expect(await session.text()).toContain("did not come through tailscale serve");
      expect((await hub.raw("/", { headers: forged })).status).toBe(403);
      // With a session someone else was granted, too.
      const token = await hub.grant();
      const status = await hub.raw("/api/status", {
        headers: { ...forged, "x-t3-fleet-token": token },
      });
      expect(status.status).toBe(403);
    } finally {
      await hub.dispose();
    }
  });

  // What /proc/net/tcp lists on a hub where tailscaled (root) proxies 127.0.0.1:41000 to the relay on 8399,
  // and a program of uid 1000 connected from 127.0.0.1:42000.
  const TCP = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:20CF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1",
    "   1: 0100007F:A028 0100007F:20CF 01 00000000:00000000 00:00000000 00000000     0        0 2 1",
    "   2: 0100007F:20CF 0100007F:A028 01 00000000:00000000 00:00000000 00000000  1000        0 3 1",
    "   3: 0100007F:A410 0100007F:20CF 01 00000000:00000000 00:00000000 00000000  1000        0 4 1",
    "",
  ].join("\n");

  it("reads whose socket asked from the kernel's table", () => {
    expect(socketOwner(TCP, { remotePort: 41000, localPort: 8399 })).toBe(0);
    expect(socketOwner(TCP, { remotePort: 42000, localPort: 8399 })).toBe(1000);
    expect(socketOwner(TCP, { remotePort: 43000, localPort: 8399 })).toBe(null);
    expect(tailscaledUid("Name:\ttailscaled\nUid:\t0\t0\t0\t0\n")).toBe(0);
    expect(tailscaledUid("Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n")).toBe(null);
    expect(connectionOf({ socket: { remotePort: 41000, localPort: 8399 } })).toEqual({
      remotePort: 41000,
      localPort: 8399,
    });
    expect(connectionOf(new Request("http://x/"))).toBe(null);
  });

  it("lets in tailscaled's connections only, and on a hub that is not Linux none", async () => {
    const proc = fs.mkdtempSync(join(tmpdir(), "t3-fleet-proc-"));
    fs.mkdirSync(join(proc, "net"));
    fs.writeFileSync(join(proc, "net/tcp"), TCP);
    fs.writeFileSync(join(proc, "net/tcp6"), "header\n");
    const check = (remotePort: number, platform = "linux") =>
      Effect.runPromise(
        servedByTailscale({ remotePort, localPort: 8399 }, platform, proc).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
    expect(await check(41000)).toBe(null);
    expect(await check(42000)).toContain("another program on the hub");
    expect(await check(43000)).toContain("could not be told");
    expect(await check(41000, "darwin")).toContain("only a Linux hub can");
    // tailscaled run as uid 1000 (userspace networking): that user's connections are its.
    fs.mkdirSync(join(proc, "77"));
    fs.writeFileSync(join(proc, "77/status"), "Name:\ttailscaled\nUid:\t1000\t1000\t1000\t1000\n");
    expect(await check(42000)).toBe(null);
  });
});
