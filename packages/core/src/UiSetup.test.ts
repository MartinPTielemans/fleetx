// The UI server in setup mode, against a fake setup engine: what the wizard's endpoints
// answer, and how a setup run becomes jobs and turns the server into the fleet's.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { describe, expect, it } from "vite-plus/test";

import { UiJob, UiSession, UiSessionGrant, type UiSession as Session } from "./Api.ts";
import {
  UiInvite,
  UiProbe,
  UiSetupPlan,
  UiSetupStarted,
  UiSetupState,
  type UiSetupPlanRequest,
} from "./SetupApi.ts";
import type { SetupActions, SetupJob } from "./setup/Wizard.ts";
import { uiLayer, type UiActions } from "./UiServer.ts";

const PORT = 8396;
const TICKET = "d".repeat(48);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) => Schema.decodeSync(Schema.fromJsonString(schema))(text);

const tick = (ms = 10) => Effect.runPromise(Effect.sleep(ms));

const gate = () => {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open: () => open(), wait: Effect.promise(() => opened) };
};

const PLAN_ID = "f".repeat(64);
const request: UiSetupPlanRequest = {
  repo: { kind: "github", name: "t3-fleet" },
  node: "laptop",
  hub: { ssh: "me@hub", node: "hub" },
  extras: [],
};

const plan: typeof UiSetupPlan.Type = {
  planId: PLAN_ID,
  mode: "first",
  node: "laptop",
  commits: true,
  repo: { path: "~/fleet", remote: "github.com/me/t3-fleet" },
  add: [{ kind: "skill", name: "review", from: "~/.claude/skills", note: null }],
  same: [],
  conflicts: [],
  leftAlone: [],
  secrets: [{ name: "CTX_API_KEY", server: "ctx", from: "Claude Code: arg --api-key" }],
  missing: [],
  hub: {
    node: "hub",
    ssh: "me@hub",
    relayUrl: "https://hub.tailnet.ts.net:8399",
    steps: ["Add hub"],
  },
  steps: ["the config repo at ~/fleet"],
};

/** A wizard engine whose runs wait on a gate; and a machine that is in a fleet once setup ran. */
const fakeSetup = () => {
  const ran: Array<string> = [];
  const values: Array<Readonly<Record<string, string>>> = [];
  const state = { inFleet: false, gate: gate(), failHub: false };
  const job = (kind: SetupJob["kind"], title: string): SetupJob => ({
    kind,
    title,
    run: (step) =>
      Effect.gen(function* () {
        yield* step(`${kind}: first step`);
        if (kind === "setup") yield* state.gate.wait;
        if (kind === "setup-hub" && state.failHub) return yield* Effect.fail("ssh me@hub: refused");
        ran.push(kind);
        if (kind === "setup") state.inFleet = true;
      }),
  });
  const actions: SetupActions = {
    state: Effect.sync(() => ({
      stage: state.inFleet ? "member" : "fresh",
      hostname: "Laptop.local",
      suggestedName: "laptop",
      checks: [{ key: "node", severity: "ok", title: "Node 24.13.1", detail: null }],
      github: "me",
      unfinished: null,
      hub: null,
      fleetUrl: state.inFleet ? "https://box.tailnet.ts.net:8399/" : null,
    })),
    probe: (ssh) =>
      Effect.succeed({
        ssh,
        reachable: true,
        error: null,
        hostname: "hub",
        os: "linux",
        node: { state: "ok", label: "Node 24", remedy: null },
        git: { state: "ok", label: "git", remedy: null },
        t3: { state: "ok", label: "T3", remedy: null },
        tailscale: { state: "ok", label: "tailscale", remedy: null },
        docker: { state: "missing", label: "no docker", remedy: "install docker" },
        service: { state: "ok", label: "systemd", remedy: null },
        relayUrl: "https://hub.tailnet.ts.net:8399",
        ready: true,
      }),
    plan: (r) =>
      r.node === "Laptop" ? Effect.fail('"Laptop" is not a machine name') : Effect.succeed(plan),
    apply: (r) => {
      if (r.kind === "abandon") return Effect.succeed([]);
      if (r.kind === "resume") return Effect.fail("there is no unfinished setup to resume");
      if (r.planId !== PLAN_ID)
        return Effect.fail("this machine or the fleet changed since the plan was made: plan again");
      values.push(r.values);
      return Effect.succeed([job("setup", "Set up laptop"), job("setup-hub", "Bring up hub")]);
    },
    invite: (node) =>
      Effect.succeed({ command: `curl -fsSL https://x/install.sh | sh -s -- setup url ${node}` }),
  };
  return { actions, ran, values, state };
};

const noFleet: UiActions = {
  check: Effect.fail("not in a fleet"),
  apply: () => Effect.succeed([]),
  proposals: Effect.succeed([]),
  approve: () => Effect.fail("no"),
  reject: () => Effect.fail("no"),
  alerts: Effect.succeed([]),
  config: () => Effect.fail("no"),
  skills: {
    list: Effect.succeed([]),
    lookup: () => Effect.fail("no"),
    add: () => Effect.fail("no"),
    preview: () => Effect.fail("no"),
    update: () => Effect.fail("no"),
    remove: () => Effect.fail("no"),
  },
};

const serve = () => {
  const setup = fakeSetup();
  let checks = 0;
  const actions: UiActions = {
    ...noFleet,
    check: Effect.suspend(() => {
      checks++;
      return Effect.fail("not in a fleet");
    }),
  };
  const fleetSession: Session = {
    version: "0.0.0",
    self: "laptop",
    authority: true,
    nodes: ["laptop", "hub"],
    relay: "https://hub.tailnet.ts.net:8399",
  };
  const setupSession: Session = { ...fleetSession, authority: false, nodes: [], relay: null };
  const { handler, dispose } = HttpRouter.toWebHandler(
    uiLayer({
      ticket: TICKET,
      port: PORT,
      assets: new Map(),
      session: Effect.sync(() => (setup.state.inFleet ? fleetSession : setupSession)),
      relay: Effect.succeed(null),
      inFleet: Effect.sync(() => setup.state.inFleet),
      actions,
      setup: setup.actions,
    }).pipe(
      Layer.provide(
        Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((r) =>
            Effect.succeed(HttpClientResponse.fromWeb(r, new Response(null, { status: 404 }))),
          ),
        ),
      ),
    ),
    { disableLogger: true },
  );
  const raw = (path: string, init: RequestInit & { readonly token?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", `127.0.0.1:${PORT}`);
    if (init.token !== undefined) headers.set("x-t3-fleet-token", init.token);
    return handler(new Request(`${ORIGIN}${path}`, { ...init, headers }));
  };
  let token: Promise<string> | null = null;
  const session = () =>
    (token ??= raw("/api/session", {
      method: "POST",
      headers: { "x-t3-fleet-ticket": TICKET },
    }).then(async (r) => decode(UiSessionGrant, await r.text()).token));
  const call = async (path: string, init: RequestInit = {}) =>
    raw(path, { ...init, token: await session() });
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", body: JSON.stringify(body) });
  const jobs = async () => decode(Schema.Array(UiJob), await (await call("/api/jobs")).text());
  const settled = async () => {
    for (let i = 0; i < 300; i++) {
      const all = await jobs();
      if (all.length > 0 && all.every((j) => j.state === "done" || j.state === "failed"))
        return all;
      await tick();
    }
    throw new Error("jobs did not finish");
  };
  return { setup, raw, call, post, jobs, settled, dispose, checks: () => checks };
};

describe("the UI server in setup mode", () => {
  it("answers the session for the machine setup would make, and checks nothing", async () => {
    const server = serve();
    expect((await server.raw("/api/setup/state")).status).toBe(401);
    const session = decode(UiSession, await (await server.call("/api/session")).text());
    expect(session).toMatchObject({ self: "laptop", authority: false, nodes: [], relay: null });
    const state = decode(UiSetupState, await (await server.call("/api/setup/state")).text());
    expect(state).toMatchObject({ stage: "fresh", suggestedName: "laptop", github: "me" });
    await tick(30);
    expect(server.checks()).toBe(0);
    await server.dispose();
  });

  it("probes only an ssh destination, and plans", async () => {
    const server = serve();
    expect((await server.post("/api/setup/probe", { ssh: "-oProxyCommand=sh" })).status).toBe(400);
    expect((await server.post("/api/setup/probe", { ssh: "me@hub two" })).status).toBe(400);
    const probe = decode(
      UiProbe,
      await (await server.post("/api/setup/probe", { ssh: "me@hub" })).text(),
    );
    expect(probe).toMatchObject({ ready: true, relayUrl: "https://hub.tailnet.ts.net:8399" });
    expect((await server.post("/api/setup/plan", { nope: 1 })).status).toBe(400);
    expect(
      (await server.post("/api/setup/plan", { ...request, hub: { ssh: "-x", node: "hub" } }))
        .status,
    ).toBe(400);
    const refused = await server.post("/api/setup/plan", { ...request, node: "Laptop" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("not a machine name");
    const planned = decode(
      UiSetupPlan,
      await (await server.post("/api/setup/plan", request)).text(),
    );
    expect(planned.planId).toBe(PLAN_ID);
    await server.dispose();
  });

  it("refuses a stale plan, so the app plans again", async () => {
    const server = serve();
    const response = await server.post("/api/setup/apply", {
      kind: "plan",
      planId: "0".repeat(64),
      choices: {},
      values: {},
    });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("plan again");
    expect(await server.jobs()).toEqual([]);
    await server.dispose();
  });

  it("applies as a setup job, then the hub's, one setup at a time; then it is the fleet's", async () => {
    const server = serve();
    const events = await server.call("/api/events");
    const response = await server.post("/api/setup/apply", {
      kind: "plan",
      planId: PLAN_ID,
      choices: {},
      values: { CTX_API_KEY: "ctx-SEKRIT-0123456789" },
    });
    expect(response.status).toBe(202);
    const { jobId } = decode(UiSetupStarted, await response.text());
    await tick(30);
    const running = await server.jobs();
    expect(running.map((j) => [j.kind, j.state])).toEqual([["setup", "running"]]);
    expect(running[0]?.id).toBe(jobId);
    const again = await server.post("/api/setup/apply", {
      kind: "plan",
      planId: PLAN_ID,
      choices: {},
      values: {},
    });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("running already");

    server.setup.state.gate.open();
    const done = await server.settled();
    expect(done.map((j) => [j.kind, j.state])).toEqual([
      ["setup", "done"],
      ["setup-hub", "done"],
    ]);
    expect(server.setup.ran).toEqual(["setup", "setup-hub"]);
    expect(server.setup.values).toEqual([{ CTX_API_KEY: "ctx-SEKRIT-0123456789" }]);

    // The app hears that the server is the fleet's now, and no value ever went into an event.
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("event: session")) text += (await reader.read()).value ?? "";
    await reader.cancel();
    expect(text).toMatch(/event: session\ndata: \{[^\n]*"nodes":\["laptop","hub"\]/);
    expect(text).not.toContain("SEKRIT");
    const session = decode(UiSession, await (await server.call("/api/session")).text());
    expect(session).toMatchObject({ authority: true, nodes: ["laptop", "hub"] });
    await tick(30);
    await server.dispose();
  });

  it("does not start the hub when setup fails, and says a failed hub's why", async () => {
    const server = serve();
    server.setup.state.failHub = true;
    server.setup.state.gate.open();
    expect(
      (
        await server.post("/api/setup/apply", {
          kind: "plan",
          planId: PLAN_ID,
          choices: {},
          values: {},
        })
      ).status,
    ).toBe(202);
    const done = await server.settled();
    expect(done.find((j) => j.kind === "setup-hub")).toMatchObject({
      state: "failed",
      error: "ssh me@hub: refused",
    });
    await server.dispose();
  });

  it("abandons without a job, and invites", async () => {
    const server = serve();
    const abandoned = await server.post("/api/setup/apply", { kind: "abandon" });
    expect(abandoned.status).toBe(200);
    expect(decode(UiSetupStarted, await abandoned.text())).toEqual({ jobId: null });
    const resumed = await server.post("/api/setup/apply", { kind: "resume" });
    expect(resumed.status).toBe(409);
    const invite = decode(
      UiInvite,
      await (await server.post("/api/setup/invite", { node: "desk" })).text(),
    );
    expect(invite.command).toMatch(/setup url desk$/);
    await server.dispose();
  });
});
