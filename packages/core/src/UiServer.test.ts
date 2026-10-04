import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { HubServer, UiFixPlan, UiJob, UiModels, UiSessionGrant, UiSkills, UiSkillsPreview, UiStatus } from "./Api.ts";
import type { Node } from "./Config.ts";
import type { Finding, Fix } from "./Diagnose.ts";
import type { MachineObservation } from "./Observation.ts";
import { mergeLayers } from "./Settings.ts";
import { fixDigest, refusal, uiLayer, uniqueFixes, type UiActions, type UiCheck } from "./UiServer.ts";

const PORT = 8397;
const TOKEN = "a".repeat(48);
const TICKET = "c".repeat(48);
/** The change digest of the one proposal the fake fleet has. */
const REVIEWED = "e".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const node = (name: string): Node => ({
  name,
  ssh: name === "laptop" ? null : name,
  roles: ["member"],
  profiles: [],
  tailnet: null,
  settings: mergeLayers(name === "server" ? [{ source: "node server", table: { skills: { ignore: ["drafts"] } } }] : []),
});

const observation: MachineObservation = {
  protocol: 5,
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
    access: null,
    providers: [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        binaryPath: "~/.local/bin/t3-fleet-claude",
        resolved: "~/.local/bin/t3-fleet-claude",
        launch: { ok: true, version: "2.1.0", detail: "" },
      },
    ],
    problems: [],
  },
  proxy: null,
  areas: {
    skills: {
      store: "/Users/u/.agents/skills",
      vendored: ["review"],
      links: [
        { skill: "review", dir: "/Users/u/.agents/skills", state: "ok" },
        { skill: "review", dir: "/Users/u/.claude/skills", state: "missing" },
      ],
      strays: [{ skill: "scratch", dir: "/Users/u/.codex/skills" }],
      dangling: [],
    },
  },
  providerAuth: [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, auth: "authenticated", method: "setup-token", label: null, status: "ready", detail: "", checkedAt: 1, source: "t3" }],
  lastSync: null,
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
  const edits: Array<string> = [];
  const decided: Array<string> = [];
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
    approve: (node, change) =>
      change === REVIEWED ? Effect.sync(() => void decided.push(`approve ${node}`)) : Effect.fail(`${node}'s proposal changed since you reviewed it; review it again`),
    reject: (node) => Effect.fail(`no proposal from ${node}`),
    alerts: Effect.succeed([{ at: 5, node: "server", kind: "failing", message: "sync failed" }]),
    config: (name) => (name === "laptop" ? Effect.succeed([{ path: "a.b", value: "1", source: "defaults" }]) : Effect.fail(`unknown machine: ${name}`)),
    skills: {
      list: Effect.succeed([{ name: "review", description: "Reviews a diff", source: { name: "skills", url: "https://github.com/acme/skills.git" } }]),
      lookup: (source) => Effect.succeed({ url: source, skills: [{ name: "review", exists: true }] }),
      add: (source, names, as) =>
        Effect.sync(() => {
          edits.push(`add ${source} ${names.join(",")}${as === undefined ? "" : ` as ${as}`}`);
          return { paths: names.map((n) => `skills/${as ?? n}`), landed: "committed and pushed (abc123)" };
        }),
      preview: () => Effect.succeed({ files: ["skills/review"], stat: " 1 file changed", diff: "+new line", digest: "d1" }),
      update: (names, digest) =>
        digest === "d1"
          ? Effect.sync(() => {
              edits.push(`update ${names.join(",")}`);
              return { paths: ["skills/review"], landed: "committed and pushed (abc124)" };
            })
          : Effect.fail("upstream changed since the preview; preview again"),
      remove: (names) => Effect.sync(() => (edits.push(`remove ${names.join(",")}`), { paths: names.map((n) => `skills/${n}`), landed: "committed and pushed (abc125)" })),
    },
  };
  return { actions, applied, edits, decided };
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

const serve = (
  options: {
    readonly hub?: boolean;
    readonly relay?: boolean;
    readonly actions?: UiActions;
    readonly checkEvery?: Duration.Input;
    readonly keepJobsFor?: Duration.Input;
  } = {},
) => {
  const drained: Array<ReadonlyArray<string>> = [];
  const fleet = fakeFleet();
  const tickets: Array<string> = [];
  const assets = new Map([
    ["/index.html", { type: "text/html; charset=utf-8", body: new TextEncoder().encode("<!doctype html><title>T3 Fleet</title>") }],
    ["/assets/app-1.js", { type: "text/javascript; charset=utf-8", body: new TextEncoder().encode("console.log(1)") }],
  ]);
  const { handler, dispose } = HttpRouter.toWebHandler(
    uiLayer({
      ticket: TICKET,
      onTicketUsed: (next) => Effect.sync(() => void tickets.push(next)),
      port: PORT,
      assets,
      session: { version: "0.0.0", self: "laptop", authority: true, nodes: ["laptop", "server"], relay: options.relay === false ? null : "https://relay.example" },
      actions: options.actions ?? fleet.actions,
      relay: options.relay === false ? null : { url: "https://relay.example", token: "relay-token" },
      ...(options.checkEvery === undefined ? {} : { checkEvery: options.checkEvery }),
      ...(options.keepJobsFor === undefined ? {} : { keepJobsFor: options.keepJobsFor }),
      onDrain: (running) => Effect.sync(() => void drained.push(running)),
    }).pipe(Layer.provide(relayClient(options.hub ?? true))),
    { disableLogger: true },
  );
  const raw = (path: string, init: RequestInit & { readonly token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("host")) headers.set("host", `127.0.0.1:${PORT}`);
    if (init.token !== null && init.token !== undefined) headers.set("x-t3-fleet-token", init.token);
    return handler(new Request(`${ORIGIN}${path}`, { ...init, headers }));
  };
  /** This tab's token, traded for the link's ticket on first use. */
  let token: Promise<string> | null = null;
  const session = () =>
    (token ??= raw("/api/session", { method: "POST", headers: { "x-t3-fleet-ticket": TICKET } }).then(async (r) => decode(UiSessionGrant, await r.text()).token));
  const call = async (path: string, init: RequestInit & { readonly token?: string | null } = {}) =>
    raw(path, { ...init, token: init.token === null ? null : (init.token ?? (await session())) });
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
  /** Every job, once none is still waiting or running. */
  const settled = async () => {
    for (let i = 0; i < 200; i++) {
      const jobs = decode(Schema.Array(UiJob), await (await call("/api/jobs")).text());
      if (jobs.every((j) => j.state === "done" || j.state === "failed")) return jobs;
      await Effect.runPromise(Effect.sleep(10));
    }
    throw new Error("jobs did not finish");
  };
  /** Start a job and wait for it. */
  const job = async (path: string, body: unknown) => {
    const response = await post(path, body);
    if (response.status !== 202) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
    const started = decode(UiJob, await response.text());
    return (await settled()).find((j) => j.id === started.id)!;
  };
  return { raw, call, post, job, settled, session, tickets, drained, dispose, applied: fleet.applied, edits: fleet.edits, decided: fleet.decided };
};

/** The event stream's text until `until` appears in it. */
const readEvents = async (response: Response, until: string) => {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes(until)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  await reader.cancel();
  return text;
};

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, text: string) => Schema.decodeSync(Schema.fromJsonString(schema))(text);

describe("refusal", () => {
  const options = { port: PORT, tokens: new Set([TOKEN]) };
  const none = new URLSearchParams();
  const ok = { "host": `127.0.0.1:${PORT}`, "x-t3-fleet-token": TOKEN };

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
    expect(refusal({ method: "GET", headers: { "x-t3-fleet-token": TOKEN } }, options, none)?.status).toBe(421);
  });

  it("needs the token as a header, and takes it in the query only where allowed", () => {
    expect(refusal({ method: "GET", headers: { host: ok.host } }, options, none)?.status).toBe(401);
    expect(refusal({ method: "GET", headers: { host: ok.host, "x-t3-fleet-token": "b".repeat(48) } }, options, none)?.status).toBe(401);
    expect(refusal({ method: "POST", headers: { host: ok.host } }, options, new URLSearchParams({ token: TOKEN }))?.status).toBe(401);
    expect(refusal({ method: "GET", headers: { host: ok.host } }, { ...options, queryToken: true }, new URLSearchParams({ token: TOKEN }))).toBeNull();
  });

  it("refuses everything before a token has been handed out", () => {
    expect(refusal({ method: "GET", headers: { host: ok.host, "x-t3-fleet-token": "" } }, { port: PORT, tokens: new Set() }, none)?.status).toBe(401);
  });

  it("serves the app itself without a token, to loopback hosts only", () => {
    expect(refusal({ method: "GET", headers: { host: ok.host } }, { port: PORT, tokens: null }, none)).toBeNull();
    expect(refusal({ method: "GET", headers: { host: "evil.example" } }, { port: PORT, tokens: null }, none)?.status).toBe(421);
  });
});

describe("the UI server", () => {
  const server = serve();
  afterAll(() => server.dispose());

  it("guards every /api route", async () => {
    expect((await server.call("/api/status", { token: null })).status).toBe(401);
    expect((await server.call("/api/fixes", { method: "POST", body: '{"fixes":[],"acknowledged":[]}', headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await server.call(`/api/status?token=${await server.session()}`, { token: null })).status).toBe(401);
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
    expect(laptop?.providerAuth.map((p) => [p.instanceId, p.auth])).toEqual([["claudeAgent", "authenticated"]]);
    expect(status.environments[1]?.error).toBe("ssh server failed: unreachable");
    expect(status.findings.map((f) => f.id)).toEqual(["laptop:claude-behind", "server:noted"]);
    expect(status.findings[1]).toMatchObject({ severity: "info", accepted: "on purpose" });
    expect(status.findings[1]?.detail).toBeUndefined();
    expect(status.summary).toContain("laptop");
  });

  it("serves models, alerts and config", async () => {
    const models = decode(UiModels, await (await server.call("/api/models")).text());
    expect(models.nodes.map((n) => [n.node, n.providerAuth[0]?.auth ?? null])).toEqual([
      ["laptop", "authenticated"],
      ["server", null],
    ]);
    expect(await (await server.call("/api/alerts")).json()).toEqual([{ at: 5, node: "server", kind: "failing", message: "sync failed" }]);
    expect(await (await server.call("/api/config/laptop")).json()).toEqual([{ path: "a.b", value: "1", source: "defaults" }]);
    expect((await server.call("/api/config/nowhere")).status).toBe(404);
    expect((await server.call("/api/config/..%2F..")).status).toBe(400);
  });

  it("approves or rejects only the change that was shown, as a job", async () => {
    expect((await server.post("/api/proposals/server/approve", {})).status).toBe(400);
    expect((await server.post("/api/proposals/server/approve", { change: "--force" })).status).toBe(400);
    const stale = await server.job("/api/proposals/server/approve", { change: "f".repeat(64) });
    expect(stale).toMatchObject({ kind: "approve", state: "failed", error: "server's proposal changed since you reviewed it; review it again" });
    const approved = await server.job("/api/proposals/server/approve", { change: REVIEWED });
    expect(approved).toMatchObject({ state: "done", title: "Approve server's proposal" });
    expect(server.decided).toEqual(["approve server"]);
    expect(await server.job("/api/proposals/server/reject", { change: REVIEWED })).toMatchObject({ state: "failed", error: "no proposal from server" });
  });

  it("plans fixes as they stand, then applies only those still the same, then checks again", async () => {
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:claude-behind", "server:noted", "laptop:made-up"] })).text());
    expect(planned.fixes).toEqual([
      { id: "laptop:claude-behind", node: "laptop", title: upgrade.title, command: upgrade.fix.command, safe: true, digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect(planned.notApplicable).toEqual([
      { id: "server:noted", reason: "this finding has no automatic fix" },
      { id: "laptop:made-up", reason: "no longer found; it may already be fixed" },
    ]);

    const fixes = planned.fixes.map((f) => ({ id: f.id, digest: f.digest }));
    const job = await server.job("/api/fixes", { fixes: [...fixes, { id: "laptop:made-up", digest: "x" }], acknowledged: [] });
    expect(job).toMatchObject({ kind: "fixes", state: "done", title: "Apply 2 fixes on 1 machine" });
    expect(server.applied).toEqual(["laptop:claude-behind"]);
    expect(job.applied).toEqual({
      results: [{ id: "laptop:claude-behind", node: "laptop", title: upgrade.title, ok: true, output: "upgraded" }],
      notApplied: [{ id: "laptop:made-up", reason: "no longer found; it may already be fixed" }],
    });
    const after = decode(UiStatus, await (await server.call("/api/status")).text());
    expect(after.findings.map((f) => f.id)).toEqual(["server:noted"]);

    const again = await server.job("/api/fixes", { fixes, acknowledged: [] });
    expect(again.applied?.results).toEqual([]);
    expect(server.applied).toEqual(["laptop:claude-behind"]);
    expect((await server.post("/api/fixes", { ids: ["laptop:claude-behind"] })).status).toBe(400);
    expect((await server.call("/api/fixes", { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("serves the repo's skills with each machine's links", async () => {
    const skills = decode(UiSkills, await (await server.call("/api/skills")).text());
    expect(skills.skills.map((s) => s.name)).toEqual(["review"]);
    expect(skills.nodes).toEqual([
      {
        node: "laptop",
        at: 1_000,
        store: "/Users/u/.agents/skills",
        links: [
          { skill: "review", dir: "/Users/u/.agents/skills", state: "ok" },
          { skill: "review", dir: "/Users/u/.claude/skills", state: "missing" },
        ],
        strays: [{ skill: "scratch", dir: "/Users/u/.codex/skills" }],
        dangling: [],
        ignored: [],
      },
      { node: "server", at: null, store: null, links: [], strays: [], dangling: [], ignored: ["drafts"] },
    ]);
  });

  it("changes skills only from well-formed requests", async () => {
    const post = server.post;
    expect((await post("/api/skills/add", { source: "--upload-pack=touch /tmp/x", skills: [] })).status).toBe(400);
    expect((await post("/api/skills/add", { source: "acme/skills", skills: ["../etc"] })).status).toBe(400);
    expect((await post("/api/skills/add", { source: "acme/skills", skills: ["review"], as: "-x" })).status).toBe(400);
    expect((await post("/api/skills/remove", { skills: [] })).status).toBe(400);
    expect((await post("/api/skills/lookup", { nope: 1 })).status).toBe(400);
    expect(server.edits).toEqual([]);

    expect(await (await post("/api/skills/lookup", { source: "acme/skills" })).json()).toEqual({ url: "acme/skills", skills: [{ name: "review", exists: true }] });
    const added = await server.job("/api/skills/add", { source: "https://github.com/acme/skills.git", skills: ["review"], as: "review2" });
    expect(added).toMatchObject({ kind: "skills-add", state: "done", landed: { paths: ["skills/review2"], landed: "committed and pushed (abc123)" } });
    expect(server.edits).toEqual(["add https://github.com/acme/skills.git review as review2"]);
  });

  it("keeps an update only with the preview's digest", async () => {
    const preview = decode(UiSkillsPreview, await (await server.post("/api/skills/preview", { skills: ["review"] })).text());
    expect(preview.digest).toBe("d1");
    const stale = await server.job("/api/skills/update", { skills: ["review"], digest: "other" });
    expect(stale).toMatchObject({ state: "failed", error: "upstream changed since the preview; preview again" });
    expect(await server.job("/api/skills/update", { skills: ["review"], digest: preview.digest })).toMatchObject({ state: "done" });
    expect(await server.job("/api/skills/remove", { skills: ["review"] })).toMatchObject({ state: "done" });
    expect(server.edits.slice(-2)).toEqual(["update review", "remove review"]);
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
    expect(await index.text()).toContain("<title>T3 Fleet</title>");
    expect(await (await server.call("/findings", { token: null })).text()).toContain("<title>T3 Fleet</title>");
    const asset = await server.call("/assets/app-1.js", { token: null });
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    // A port can be someone else's between runs: nothing from then may be cached for this one.
    expect(asset.headers.get("cache-control")).toBe("no-store");
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

/** A promise the test resolves when it wants a fake to go on. */
const gate = () => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

const tick = (ms = 20) => Effect.runPromise(Effect.sleep(ms));

/** A fleet with one fixable finding whose command, interruption and pace the test controls. */
const controlledFleet = () => {
  const state = {
    command: "rm ~/.claude/skills/foo",
    disrupts: undefined as string | undefined,
    fixed: false,
    checks: 0,
    checkGate: null as ReturnType<typeof gate> | null,
    applyGate: null as ReturnType<typeof gate> | null,
    failNextCheck: false,
    applied: [] as Array<string>,
    interrupted: false,
  };
  const finding = (): Finding => ({
    node: "laptop",
    key: "skills-dangling",
    severity: "warn",
    area: "skills",
    title: "a skill link points at nothing",
    fix: { command: state.command, safe: true, ...(state.disrupts === undefined ? {} : { disrupts: state.disrupts }) },
  });
  const actions: UiActions = {
    ...fakeFleet().actions,
    check: Effect.gen(function* () {
      state.checks++;
      if (state.checkGate !== null) yield* Effect.promise(() => state.checkGate!.promise);
      if (state.failNextCheck) {
        state.failNextCheck = false;
        return yield* Effect.fail("ssh laptop failed: timed out");
      }
      return fakeCheck(state.fixed ? [] : [finding()]);
    }),
    apply: (fixes) =>
      Effect.gen(function* () {
        if (state.applyGate !== null) yield* Effect.promise(() => state.applyGate!.promise);
        state.applied.push(...fixes.map((f) => f.fix.command));
        state.fixed = true;
        return fixes.map((f) => ({ finding: f, ok: true, summary: "done" }));
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => (state.interrupted = true)))),
  };
  return { state, actions };
};

describe("the link", () => {
  it("works once, and each use leaves a new one for another tab", async () => {
    const server = serve();
    const trade = (ticket: string) => server.raw("/api/session", { method: "POST", headers: { "x-t3-fleet-ticket": ticket } });
    const first = await trade(TICKET);
    expect(first.status).toBe(200);
    const { token } = decode(UiSessionGrant, await first.text());
    expect((await server.raw("/api/session", { token })).status).toBe(200);

    const again = await trade(TICKET);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain("already used");
    expect((await trade("d".repeat(48))).status).toBe(401);
    expect((await server.raw("/api/session", { method: "POST" })).status).toBe(401);

    expect(server.tickets).toHaveLength(1);
    const second = await trade(server.tickets[0]!);
    expect(second.status).toBe(200);
    expect(decode(UiSessionGrant, await second.text()).token).not.toBe(token);
    await server.dispose();
  });
});

describe("applying fixes", () => {
  it("does not run a fix whose command changed since it was reviewed", async () => {
    const fleet = controlledFleet();
    const server = serve({ actions: fleet.actions });
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:skills-dangling"] })).text());
    expect(planned.fixes.map((f) => f.command)).toEqual(["rm ~/.claude/skills/foo"]);

    fleet.state.command = "rm ~/.claude/skills/foo; rm ~/.claude/skills/bar";
    const job = await server.job("/api/fixes", { fixes: planned.fixes.map((f) => ({ id: f.id, digest: f.digest })), acknowledged: [] });
    expect(job.applied).toEqual({ results: [], notApplied: [{ id: "laptop:skills-dangling", reason: "changed since you reviewed it; review it again" }] });
    expect(fleet.state.applied).toEqual([]);
    await server.dispose();
  });

  it("runs a fix that interrupts something only when that was acknowledged", async () => {
    const fleet = controlledFleet();
    fleet.state.disrupts = "running threads";
    const server = serve({ actions: fleet.actions });
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:skills-dangling"] })).text());
    expect(planned.fixes[0]?.disrupts).toBe("running threads");
    const fixes = planned.fixes.map((f) => ({ id: f.id, digest: f.digest }));

    const unacknowledged = await server.job("/api/fixes", { fixes, acknowledged: [] });
    expect(unacknowledged.applied?.notApplied).toEqual([{ id: "laptop:skills-dangling", reason: "interrupts running threads, and that was not confirmed" }]);
    expect(fleet.state.applied).toEqual([]);

    const acknowledged = await server.job("/api/fixes", { fixes, acknowledged: ["laptop:skills-dangling"] });
    expect(acknowledged.applied?.results.map((r) => r.ok)).toEqual([true]);
    expect(fleet.state.applied).toEqual(["rm ~/.claude/skills/foo"]);
    await server.dispose();
  });

  it("keeps running after the request that started it is gone", async () => {
    const fleet = controlledFleet();
    const server = serve({ actions: fleet.actions });
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:skills-dangling"] })).text());
    fleet.state.applyGate = gate();

    const abort = new AbortController();
    const response = await server.call("/api/fixes", {
      method: "POST",
      body: JSON.stringify({ fixes: planned.fixes.map((f) => ({ id: f.id, digest: f.digest })), acknowledged: [] }),
      signal: abort.signal,
    });
    expect(response.status).toBe(202);
    const started = decode(UiJob, await response.text());
    abort.abort();
    await tick(50);
    const running = decode(Schema.Array(UiJob), await (await server.call("/api/jobs")).text()).find((j) => j.id === started.id);
    expect(running).toMatchObject({ state: "running", step: "running 1 fix" });

    fleet.state.applyGate.open();
    const done = (await server.settled()).find((j) => j.id === started.id);
    expect(done).toMatchObject({ state: "done", applied: { results: [{ ok: true }] } });
    expect(fleet.state.interrupted).toBe(false);
    await server.dispose();
  });
});

describe("checks", () => {
  it("share the one running: start, every tab, and Check now", async () => {
    const fleet = controlledFleet();
    fleet.state.checkGate = gate();
    const server = serve({ actions: fleet.actions });
    await server.session();
    const asked = [server.call("/api/status"), server.call("/api/status?fresh=1"), server.call("/api/models"), server.call("/api/status?fresh=1")];
    const events = server.call("/api/events");
    await tick();
    fleet.state.checkGate.open();
    for (const response of await Promise.all(asked)) expect(response.status).toBe(200);
    await readEvents(await events, "event: check");
    expect(fleet.state.checks).toBe(1);

    await server.call("/api/status");
    expect(fleet.state.checks).toBe(1);
    await server.call("/api/status?fresh=1");
    expect(fleet.state.checks).toBe(2);
    await server.dispose();
  });

  it("never look at a machine while fixes run on it", async () => {
    const fleet = controlledFleet();
    const server = serve({ actions: fleet.actions });
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:skills-dangling"] })).text());
    fleet.state.applyGate = gate();
    expect((await server.post("/api/fixes", { fixes: planned.fixes.map((f) => ({ id: f.id, digest: f.digest })), acknowledged: [] })).status).toBe(202);
    await tick(50);
    const checksBefore = fleet.state.checks;

    const during = server.call("/api/status?fresh=1");
    await tick(50);
    expect(fleet.state.checks).toBe(checksBefore);
    fleet.state.applyGate.open();
    const status = decode(UiStatus, await (await during).text());
    expect(status.findings).toEqual([]);
    await server.settled();
    // The fix job's own check afterwards shared that one.
    expect(fleet.state.checks).toBe(checksBefore + 1);
    await server.dispose();
  });

  it("are the first thing a tab hears, and so are their failures", async () => {
    const fleet = controlledFleet();
    const server = serve({ actions: fleet.actions });
    await server.call("/api/status");
    const first = await readEvents(await server.call("/api/events"), "event: check\n");
    expect(first.split("\n\n")[1]).toMatch(/^event: check\ndata: \{"checkedAt"/);

    fleet.state.failNextCheck = true;
    const failed = await server.call("/api/status?fresh=1");
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("ssh laptop failed: timed out");
    const token = await server.session();
    const reconnected = await readEvents(await server.raw(`/api/events?token=${token}`), "event: check-failed");
    expect(reconnected).toContain("event: check\n");
    expect(reconnected).toMatch(/event: check-failed\ndata: \{"at":\d+,"message":"ssh laptop failed: timed out"\}/);
    await server.dispose();
  });
});

describe("a fix's digest", () => {
  it("changes with anything that changes what running it does", async () => {
    const digest = (fix: Partial<Fix>) => Effect.runPromise(fixDigest({ ...upgrade, fix: { ...upgrade.fix, ...fix } }));
    const base = await digest({});
    expect(await digest({})).toBe(base);
    expect(await digest({ command: `${upgrade.fix.command} --force` })).not.toBe(base);
    expect(await digest({ on: "server" })).not.toBe(base);
    expect(await digest({ disrupts: "running threads" })).not.toBe(base);
    expect(await digest({ disrupts: "running threads and the relay" })).not.toBe(await digest({ disrupts: "running threads" }));
    expect(await digest({ safe: false })).not.toBe(base);
    expect(await Effect.runPromise(fixDigest({ ...upgrade, node: "server" }))).not.toBe(base);
  });
});

describe("jobs", () => {
  it("run a fix named twice once", async () => {
    expect(uniqueFixes([{ id: "a:x", digest: "1" }, { id: "a:x", digest: "1" }])).toEqual([{ id: "a:x", digest: "1" }]);
    expect(uniqueFixes([{ id: "a:x", digest: "1" }, { id: "a:x", digest: "2" }])).toBe("a:x is asked for twice, as two different fixes");

    const fleet = controlledFleet();
    const server = serve({ actions: fleet.actions });
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:skills-dangling", "laptop:skills-dangling"] })).text());
    expect(planned.fixes).toHaveLength(1);
    const fix = { id: planned.fixes[0]!.id, digest: planned.fixes[0]!.digest };
    const job = await server.job("/api/fixes", { fixes: [fix, fix], acknowledged: [] });
    expect(job.title).toBe("Apply 1 fix on 1 machine");
    expect(job.applied?.results).toHaveLength(1);
    expect(fleet.state.applied).toEqual(["rm ~/.claude/skills/foo"]);
    expect((await server.post("/api/fixes", { fixes: [fix, { ...fix, digest: "other" }], acknowledged: [] })).status).toBe(400);
    await server.dispose();
  });

  it("are forgotten a while after they finish, whether or not another starts", async () => {
    const server = serve({ keepJobsFor: "100 millis" });
    expect(await server.job("/api/skills/remove", { skills: ["review"] })).toMatchObject({ state: "done" });
    expect(decode(Schema.Array(UiJob), await (await server.call("/api/jobs")).text())).toHaveLength(1);
    await tick(300);
    expect(decode(Schema.Array(UiJob), await (await server.call("/api/jobs")).text())).toEqual([]);
    await server.dispose();
  });

  it("are waited for when the server stops, not stopped halfway", async () => {
    const fleet = controlledFleet();
    const server = serve({ actions: fleet.actions });
    const planned = decode(UiFixPlan, await (await server.post("/api/fixes/plan", { ids: ["laptop:skills-dangling"] })).text());
    fleet.state.applyGate = gate();
    expect((await server.post("/api/fixes", { fixes: planned.fixes.map((f) => ({ id: f.id, digest: f.digest })), acknowledged: [] })).status).toBe(202);
    await tick(50);

    let stopped = false;
    const stopping = server.dispose().then(() => (stopped = true));
    await tick(100);
    expect(server.drained).toEqual([["Apply 1 fix on 1 machine"]]);
    expect(stopped).toBe(false);
    expect(fleet.state.interrupted).toBe(false);

    fleet.state.applyGate.open();
    await stopping;
    expect(fleet.state.applied).toEqual(["rm ~/.claude/skills/foo"]);
    expect(fleet.state.interrupted).toBe(false);
  });
});
