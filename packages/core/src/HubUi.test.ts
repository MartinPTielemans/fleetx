// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
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
  darwinSocket,
  decodeHeaderValue,
  identify,
  liveDarwinLookup,
  liveLinuxLookup,
  refusedPage,
  servedByTailscale,
  installedTailscaled,
  socketOwner,
  statusUid,
  tailscaledUser,
  type DarwinLookup,
  type LinuxLookup,
  type PathOwner,
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
    expect(statusUid("Name:\ttailscaled\nUid:\t0\t0\t0\t0\n")).toBe(0);
    expect(statusUid("Name:\tnode\nUid:\t1000\t1000\t1000\t1000\n")).toBe(1000);
    expect(statusUid("Name:\tnode\n")).toBe(null);
    expect(connectionOf({ socket: { remotePort: 41000, localPort: 8399 } })).toEqual({
      remotePort: 41000,
      localPort: 8399,
    });
    expect(connectionOf(new Request("http://x/"))).toBe(null);
  });

  // A Linux hub as the relay's check sees it. Where systemd's tailscaled unit runs
  // (`main`: its MainPID, null for none), the program each process runs, and who
  // owns what, as stat says: an installed /usr/sbin/tailscaled by default.
  const INSTALLED: Record<string, PathOwner> = {
    "/": { uid: 0, mode: 0o755 },
    "/usr": { uid: 0, mode: 0o755 },
    "/usr/sbin": { uid: 0, mode: 0o755 },
    "/usr/sbin/tailscaled": { uid: 0, mode: 0o755 },
    "/tmp": { uid: 0, mode: 0o1777 },
    "/tmp/tailscaled": { uid: 1000, mode: 0o755 },
    "/srv": { uid: 0, mode: 0o755 },
    "/srv/user": { uid: 1000, mode: 0o750 },
    "/srv/user/tailscaled": { uid: 1000, mode: 0o755 },
    "/usr/bin": { uid: 0, mode: 0o755 },
    "/usr/bin/sleep": { uid: 0, mode: 0o755 },
  };
  const linux = (
    main: number | null,
    exes: Record<number, string>,
    owners: Record<string, PathOwner> = INSTALLED,
  ): LinuxLookup => ({
    mainPid: Effect.succeed(main),
    exe: (pid) => Effect.succeed(exes[pid] ?? null),
    owners: (paths) => Effect.succeed(new Map(paths.map((p) => [p, owners[p] ?? null]))),
  });
  const procWith = (statuses: Record<number, string>) => {
    const proc = fs.mkdtempSync(join(tmpdir(), "t3-fleet-proc-"));
    fs.mkdirSync(join(proc, "net"));
    fs.writeFileSync(join(proc, "net/tcp"), TCP);
    fs.writeFileSync(join(proc, "net/tcp6"), "header\n");
    for (const [pid, status] of Object.entries(statuses)) {
      fs.mkdirSync(join(proc, pid));
      fs.writeFileSync(join(proc, pid, "status"), status);
    }
    return proc;
  };
  const status = (uid: number, name = "tailscaled") =>
    `Name:\t${name}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
  const checkOn =
    (proc: string, lookup: LinuxLookup = linux(null, {})) =>
    (remotePort: number, platform = "linux") =>
      Effect.runPromise(
        servedByTailscale(
          { remotePort, localPort: 8399 },
          platform,
          proc,
          liveDarwinLookup,
          lookup,
        ).pipe(Effect.provide(NodeServices.layer)),
      );

  it("lets in tailscaled's connections only, and on a hub that is not Linux none", async () => {
    const check = checkOn(procWith({}));
    expect(await check(41000)).toBe(null);
    expect(await check(42000)).toContain("another program on the hub");
    expect(await check(43000)).toContain("could not be told");
    expect(await check(41000, "freebsd")).toContain("only a Linux or macOS hub can");
  });

  it("trusts root's connections without asking who tailscaled is", async () => {
    // The usual install: tailscaled runs as root under systemd. Root's socket is let in,
    // and no other uid is, even one with a program named tailscaled.
    const proc = procWith({ 1: status(0), 77: status(1000) });
    const lookup = linux(1, { 1: "/usr/sbin/tailscaled", 77: "/tmp/tailscaled" });
    expect(await checkOn(proc, lookup)(41000)).toBe(null);
    expect(await checkOn(proc, lookup)(42000)).toContain("another program on the hub");
    // Root is root, even when systemd cannot be asked.
    const failing: LinuxLookup = { ...lookup, mainPid: Effect.succeed(null) };
    expect(await checkOn(proc, failing)(41000)).toBe(null);
  });

  it("refuses a program a user named tailscaled (cp /bin/sleep /tmp/tailscaled)", async () => {
    // No tailscaled unit, and uid 1000 runs /tmp/tailscaled: once its name was enough.
    const spoof = procWith({ 77: status(1000) });
    expect(await checkOn(spoof, linux(null, { 77: "/tmp/tailscaled" }))(42000)).toContain(
      "another program on the hub",
    );
    // A user's own systemd unit named tailscaled, running that copy, or an installed
    // program by another name, is not it either.
    expect(await checkOn(spoof, linux(77, { 77: "/tmp/tailscaled" }))(42000)).toContain(
      "another program on the hub",
    );
    expect(await checkOn(spoof, linux(77, { 77: "/srv/user/tailscaled" }))(42000)).toContain(
      "another program on the hub",
    );
    expect(await checkOn(spoof, linux(77, { 77: "/usr/bin/sleep" }))(42000)).toContain(
      "another program on the hub",
    );
  });

  it("trusts a tailscaled run as a user only as systemd's unit, from an installed program", async () => {
    // userspace networking: systemd runs /usr/sbin/tailscaled as uid 1000.
    const proc = procWith({ 77: status(1000) });
    expect(await checkOn(proc, linux(77, { 77: "/usr/sbin/tailscaled" }))(42000)).toBe(null);
    // The same, but the program or a directory above it is a user's to change.
    const writable = { ...INSTALLED, "/usr/sbin": { uid: 0, mode: 0o775 } };
    expect(
      await checkOn(proc, linux(77, { 77: "/usr/sbin/tailscaled" }, writable))(42000),
    ).toContain("another program on the hub");
    const owned = { ...INSTALLED, "/usr/sbin/tailscaled": { uid: 1000, mode: 0o755 } };
    expect(await checkOn(proc, linux(77, { 77: "/usr/sbin/tailscaled" }, owned))(42000)).toContain(
      "another program on the hub",
    );
    // Its main process runs as another user than the socket's.
    expect(
      await checkOn(
        procWith({ 77: status(1001) }),
        linux(77, { 77: "/usr/sbin/tailscaled" }),
      )(42000),
    ).toContain("another program on the hub");
  });

  it("refuses when what tailscaled is cannot be read", async () => {
    const proc = procWith({ 77: status(1000) });
    const refused = "another program on the hub";
    // systemd not asked, or no unit.
    expect(await checkOn(proc, linux(null, { 77: "/usr/sbin/tailscaled" }))(42000)).toContain(
      refused,
    );
    // Its program not readable (another user's process), or replaced since it started.
    expect(await checkOn(proc, linux(77, {}))(42000)).toContain(refused);
    expect(
      await checkOn(proc, linux(77, { 77: "/usr/sbin/tailscaled (deleted)" }))(42000),
    ).toContain(refused);
    // Its status gone (the process exited), or a directory that cannot be read.
    expect(await checkOn(procWith({}), linux(77, { 77: "/usr/sbin/tailscaled" }))(42000)).toContain(
      refused,
    );
    const { "/usr": _usr, ...unreadable } = INSTALLED;
    expect(
      await checkOn(proc, linux(77, { 77: "/usr/sbin/tailscaled" }, unreadable))(42000),
    ).toContain(refused);
  });

  it("knows an installed tailscaled by its path and owners", () => {
    const owner = (p: string) => INSTALLED[p] ?? null;
    expect(installedTailscaled("/usr/sbin/tailscaled", owner)).toBe(true);
    expect(installedTailscaled("/tmp/tailscaled", owner)).toBe(false);
    expect(installedTailscaled("/usr/bin/sleep", owner)).toBe(false);
    expect(installedTailscaled("usr/sbin/tailscaled", owner)).toBe(false);
    expect(installedTailscaled("/usr/sbin/tailscaled", () => null)).toBe(false);
  });

  it("reads owners with stat, and a symlink as no owner", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "t3-fleet-owners-"));
    fs.writeFileSync(join(dir, "tailscaled"), "");
    fs.chmodSync(join(dir, "tailscaled"), 0o755);
    fs.symlinkSync("/bin/sh", join(dir, "link"));
    const owners = await Effect.runPromise(
      liveLinuxLookup
        .owners(["/", join(dir, "tailscaled"), join(dir, "link"), join(dir, "missing")])
        .pipe(Effect.provide(NodeServices.layer)),
    );
    expect(owners.get("/")?.uid).toBe(0);
    expect(owners.get(join(dir, "tailscaled"))).toMatchObject({ uid: process.getuid?.() });
    expect((owners.get(join(dir, "tailscaled"))?.mode ?? 0) & 0o777).toBe(0o755);
    expect(owners.get(join(dir, "link"))).toBe(null);
    expect(owners.get(join(dir, "missing"))).toBe(null);
  });

  it.skipIf(process.platform !== "linux")("reads this machine's own processes", async () => {
    // Under the real lookup, this test's own process is no tailscaled.
    const uid = await Effect.runPromise(
      tailscaledUser("/proc", { ...liveLinuxLookup, mainPid: Effect.succeed(process.pid) }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(uid).toBe(null);
  });

  // ── macOS ──

  // The records of net.inet.tcp.pcblist_n as XNU writes them (packed to 4 bytes,
  // each padded to 8): an xinpgen, then per socket its inpcb, socket, buffers,
  // stats and tcpcb, then a closing xinpgen.
  const record = (kind: number, length: number, fill: (v: DataView) => void = () => {}) => {
    const bytes = new Uint8Array((length + 7) & ~7);
    const v = new DataView(bytes.buffer);
    v.setUint32(0, length, true);
    v.setUint32(4, kind, true);
    fill(v);
    return bytes;
  };
  interface Fake {
    lport: number;
    fport: number;
    uid: number;
    pid: number;
    ePid?: number;
    state?: number;
    /** IPv4 addresses, local then foreign. */
    at?: [number, number, number, number];
    to?: [number, number, number, number];
  }
  const tcpTable = (sockets: ReadonlyArray<Fake>, closed = true) => {
    const gen = (count: number) => record(0, 24, (v) => v.setUint32(4, count, true));
    const parts = [gen(sockets.length)];
    for (const f of sockets) {
      parts.push(
        record(0x10, 104, (v) => {
          v.setUint16(16, f.fport, false);
          v.setUint16(18, f.lport, false);
          v.setUint8(44, 0x1); // INP_IPV4
          (f.to ?? [127, 0, 0, 1]).forEach((b, i) => v.setUint8(60 + i, b));
          (f.at ?? [127, 0, 0, 1]).forEach((b, i) => v.setUint8(76 + i, b));
        }),
        record(0x1, 104, (v) => {
          v.setUint32(64, f.uid, true);
          v.setInt32(68, f.pid, true);
          v.setInt32(72, f.ePid ?? 0, true);
        }),
        record(0x2, 32),
        record(0x4, 32),
        record(0x8, 112),
        record(0x20, 208, (v) => v.setInt32(36, f.state ?? 4, true)),
      );
    }
    if (closed) parts.push(gen(sockets.length));
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.byteLength;
    }
    return all;
  };
  // A Mac hub: the relay on 8399, the standalone app's system extension (root) proxying
  // from 41000, a program of uid 501 connected from 42000, the App Store extension
  // (uid 501, pid 700) from 44000, and a connection of root's elsewhere from port 42000.
  const MAC = [
    { lport: 8399, fport: 41000, uid: 501, pid: 300 },
    { lport: 41000, fport: 8399, uid: 0, pid: 893 },
    { lport: 42000, fport: 8399, uid: 501, pid: 600 },
    {
      lport: 42000,
      fport: 8399,
      uid: 0,
      pid: 1,
      to: [10, 0, 0, 7] as [number, number, number, number],
    },
    { lport: 44000, fport: 8399, uid: 501, pid: 700 },
    { lport: 45000, fport: 8399, uid: 0, pid: 893, state: 5 }, // CLOSE_WAIT
  ];

  it("reads whose socket asked from macOS's TCP table", () => {
    const table = tcpTable(MAC);
    const at = (remotePort: number) => darwinSocket(table, { remotePort, localPort: 8399 });
    expect(at(41000)).toEqual({ uid: 0, pid: 893, ePid: 0 });
    // Root's socket to another machine from the same port is not the one asking.
    expect(at(42000)).toEqual({ uid: 501, pid: 600, ePid: 0 });
    expect(at(43000)).toBe(null);
    // Only an established connection.
    expect(at(45000)).toBe(null);
    // A table cut short, or not one at all, names no one.
    expect(darwinSocket(tcpTable(MAC, false), { remotePort: 41000, localPort: 8399 })).toBe(null);
    expect(darwinSocket(table.subarray(0, 200), { remotePort: 41000, localPort: 8399 })).toBe(null);
    expect(darwinSocket(new Uint8Array(0), { remotePort: 41000, localPort: 8399 })).toBe(null);
    // Two sockets claiming the same connection: neither is believed.
    expect(
      darwinSocket(tcpTable([...MAC, { lport: 41000, fport: 8399, uid: 501, pid: 9 }]), {
        remotePort: 41000,
        localPort: 8399,
      }),
    ).toBe(null);
  });

  it("lets in, on macOS, root's connections and the App Store extension's only", async () => {
    const asked: Array<number> = [];
    const lookup = (table: Uint8Array | null): DarwinLookup => ({
      table: Effect.succeed(table),
      appStoreExtension: (pid) => Effect.sync(() => (asked.push(pid), pid === 700)),
    });
    const check = (remotePort: number, table: Uint8Array | null = tcpTable(MAC)) =>
      Effect.runPromise(
        servedByTailscale(
          { remotePort, localPort: 8399 },
          "darwin",
          "/nonexistent",
          lookup(table),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    // Owner match: root (the system extension, or tailscaled as a daemon).
    expect(await check(41000)).toBe(null);
    expect(asked).toEqual([]);
    // The App Store extension: a user's socket, from the process its signature names.
    expect(await check(44000)).toBe(null);
    // Owner mismatch: anyone else, the relay's own user included.
    expect(await check(42000)).toContain("another program on the hub");
    expect(asked).toEqual([700, 600]);
    // Lookup failure: no table, or no socket in it.
    expect(await check(41000, null)).toContain("could not be told");
    expect(await check(43000)).toContain("could not be told");
    expect(
      await Effect.runPromise(
        servedByTailscale(null, "darwin", "/nonexistent", lookup(tcpTable(MAC))).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
    ).toContain("could not be told");
  });

  // On a Mac (this runs only there): a program of this user's connects to a server on
  // loopback; the kernel's table names this process and user, and the gate refuses it,
  // since it is not tailscaled. No Tailscale is needed.
  it.skipIf(process.platform !== "darwin")(
    "names and refuses a program of this user's on a real Mac",
    async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as net.AddressInfo).port;
      const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
      const client = net.connect(port, "127.0.0.1");
      try {
        const socket = await accepted;
        const connection = connectionOf({ socket });
        expect(connection).not.toBe(null);
        const table = await Effect.runPromise(
          liveDarwinLookup.table.pipe(Effect.provide(NodeServices.layer)),
        );
        expect(table).not.toBe(null);
        expect(darwinSocket(table ?? new Uint8Array(0), connection!)).toMatchObject({
          uid: process.getuid?.(),
          pid: process.pid,
        });
        expect(
          await Effect.runPromise(
            servedByTailscale(connection, "darwin").pipe(Effect.provide(NodeServices.layer)),
          ),
        ).toContain("another program on the hub");
        expect(
          await Effect.runPromise(
            liveDarwinLookup
              .appStoreExtension(process.pid)
              .pipe(Effect.provide(NodeServices.layer)),
          ),
        ).toBe(false);
      } finally {
        client.destroy();
        server.close();
      }
    },
  );
});
