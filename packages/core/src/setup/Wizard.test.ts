// The setup wizard's engine in a temporary home: plan, a plan gone stale, a whole first-machine
// setup applied as its job, then the hub's authority side and an invite against a bare origin.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parse as parseToml } from "smol-toml";
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ProbeServices } from "../Area.ts";
import { loadConfig } from "../Config.ts";
import { readSecrets } from "../Secrets.ts";
import type { UiSetupPlanRequest } from "../SetupApi.ts";
import { DEFAULT_APPLY, newNtfyUrl, NTFY_SECRET } from "../Upkeep.ts";
import {
  admitHub,
  bringUp,
  dropHub,
  hostMcp,
  onboardingOnly,
  undoAdmission,
  writeHub,
} from "./Hub.ts";
import { RUN_ELSEWHERE, runLockPath, runningElsewhere, withRunLock } from "./Session.ts";
import * as Wizard from "./Wizard.ts";

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const run = <A, E>(effect: Effect.Effect<A, E, ProbeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(services)));
const fails = <A, E>(effect: Effect.Effect<A, E, ProbeServices>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(services)));

const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-wizard-"));
const bin = join(home, "bin");
const repo = join(home, "fleet");
const bare = join(home, "remote.git");
const saved = {
  HOME: process.env["HOME"],
  PATH: process.env["PATH"],
  KEY: process.env["CTX_API_KEY"],
};
const KEY = "ctx-SEKRIT-value-0123456789";
const git = (...args: Array<string>) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

beforeAll(() => {
  // Only what setup runs: no agent CLI, no gh, nothing that writes outside this home.
  const keep = [
    "git",
    "ssh",
    "hostname",
    "rm",
    "cp",
    "mv",
    "find",
    "mkdir",
    "sh",
    "launchctl",
    "systemctl",
    "id",
  ];
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of keep) {
    const found = execFileSync("sh", ["-c", `command -v ${tool} || true`], {
      encoding: "utf8",
    }).trim();
    if (found !== "") fs.symlinkSync(found, join(bin, tool));
  }
  process.env["HOME"] = home;
  process.env["PATH"] = `${bin}:${dirname(process.execPath)}`;
  delete process.env["CTX_API_KEY"];
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  fs.mkdirSync(join(home, ".agents/skills/demo"), { recursive: true });
  fs.writeFileSync(join(home, ".agents/skills/demo/SKILL.md"), "---\nname: demo\n---\nhi\n");
  fs.writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { ctx: { command: "npx", args: ["ctx", "--api-key", "${CTX_API_KEY}"] } },
    }),
  );
  fs.mkdirSync(join(home, ".config/git"), { recursive: true });
  fs.writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n");
});
afterAll(() => {
  process.env["HOME"] = saved.HOME;
  process.env["PATH"] = saved.PATH;
  if (saved.KEY !== undefined) process.env["CTX_API_KEY"] = saved.KEY;
});

const NTFY = newNtfyUrl();
const request: UiSetupPlanRequest = {
  repo: { kind: "local" },
  node: "laptop",
  hub: null,
  extras: [],
  autoUpdate: true,
  notify: { desktop: true, ntfy: NTFY },
};

const engine = () =>
  run(Wizard.make({ t3Connect: Effect.fail("no T3 here"), scratchDir: join(home, "scratch") }));

describe("the setup wizard's engine", () => {
  it("plans a first machine, refuses a plan gone stale, and applies one as a setup job", async () => {
    const wizard = await engine();
    expect(await run(wizard.state)).toMatchObject({ stage: "fresh", unfinished: null, hub: null });
    expect(
      await fails(wizard.plan({ ...request, hub: { ssh: "me@hub", node: "hub", mcp: false } })),
    ).toContain("the hub joins through the fleet's repository");
    expect(
      await fails(
        wizard.plan({ ...request, notify: { desktop: true, ntfy: "https://ntfy.sh/alerts" } }),
      ),
    ).toContain("not one setup makes");
    expect(await fails(wizard.plan({ ...request, node: "Laptop" }))).toContain(
      "not a machine name",
    );

    const first = await run(wizard.plan(request));
    expect(first).toMatchObject({ mode: "first", node: "laptop", commits: true, hub: null });
    expect(first.planId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.add.map((i) => `${i.kind} ${i.name}`)).toEqual(
      expect.arrayContaining(["skill demo", "server ctx", "server t3-fleet"]),
    );
    expect(first.missing.map((m) => m.name)).toEqual(["CTX_API_KEY"]);
    expect(first.steps[0]).toBe("snapshot of the clients' MCP servers (for t3-fleet leave)");
    // What it sets for looking after the machines, and the topic among the secrets, by name only.
    expect(first.settings).toEqual([
      "Keep things up to date automatically: T3 Code, when no thread is running · Claude Code and Codex · skills ([fleet] apply)",
      "Notify you on laptop for every fleet alert ([notify] desktop)",
      `Push every fleet alert to your phone with ntfy ([notify] ntfy; the topic URL is the secret ${NTFY_SECRET})`,
    ]);
    expect(first.secrets.map((x) => x.name)).toContain(NTFY_SECRET);
    expect(JSON.stringify(first)).not.toContain(NTFY);
    // The id says nothing about what was read: planning again, with nothing changed, gives it again.
    expect((await run(wizard.plan(request))).planId).toBe(first.planId);

    fs.writeFileSync(join(home, ".agents/skills/demo/SKILL.md"), "---\nname: demo\n---\nbye\n");
    expect(
      await fails(wizard.apply({ kind: "plan", planId: first.planId, choices: {}, values: {} })),
    ).toContain("changed since the plan was made");

    const plan = await run(wizard.plan(request));
    expect(
      await fails(
        wizard.apply({ kind: "plan", planId: plan.planId, choices: {}, values: { OTHER: "x" } }),
      ),
    ).toContain("not asked for in this plan: OTHER");
    const jobs = await run(
      wizard.apply({
        kind: "plan",
        planId: plan.planId,
        choices: {},
        values: { CTX_API_KEY: KEY },
      }),
    );
    expect(jobs.map((j) => j.kind)).toEqual(["setup"]);
    const steps: Array<string> = [];
    await Effect.runPromise(jobs[0]!.run((s) => Effect.sync(() => void steps.push(s))));
    expect(steps).toContain("laptop is set up.");
    expect(steps.join("\n")).not.toContain("SEKRIT");
    expect(await run(readSecrets(repo))).toContain(`CTX_API_KEY=${KEY}`);
    expect(await run(readSecrets(repo))).toContain(`${NTFY_SECRET}=${NTFY}`);
    expect(steps.join("\n")).not.toContain(NTFY);
    // Exactly the shape the notification side reads, and every update area applied by sync.
    const written = parseToml(fs.readFileSync(join(repo, "t3-fleet.toml"), "utf8")) as {
      fleet: { apply: Array<string> };
      defaults: { t3: { update: string } };
      notify: Record<string, unknown>;
    };
    expect(written.fleet.apply).toEqual([...DEFAULT_APPLY]);
    expect(written.defaults.t3.update).toBe("when-idle");
    expect(written.notify).toEqual({ desktop: ["laptop"], ntfy: NTFY_SECRET });
    expect((await run(loadConfig)).settings.notify).toEqual({
      desktop: ["laptop"],
      ntfy: NTFY_SECRET,
    });
    expect(fs.readlinkSync(join(home, ".agents/skills/demo"))).toBe(join(repo, "skills/demo"));
    expect(fs.existsSync(join(home, "scratch"))).toBe(false);
    expect(await run(wizard.state)).toMatchObject({ stage: "member", suggestedName: "laptop" });
    expect(await fails(wizard.apply({ kind: "resume" }))).toContain("no unfinished setup");
  });

  it("admits the hub on the authority: its node file, [relay], a relay token; MCP hosting only once it is up; once", async () => {
    git("remote", "add", "origin", bare);
    git("push", "-q", "-u", "origin", "main");
    const config = await run(loadConfig);
    const hub = {
      node: "hub",
      ssh: "me@hub",
      relayUrl: "https://hub.tailnet.ts.net:8399",
      error: null,
    };
    const show = (file: string) =>
      execFileSync("git", ["-C", bare, "show", `main:${file}`], { encoding: "utf8" });
    const head = () => execFileSync("git", ["-C", bare, "rev-parse", "main"], { encoding: "utf8" });
    const before = head();

    // Review A-F2: a member never admits a hub, whatever front end asked.
    const member = {
      ...config,
      nodes: config.nodes.map((n) =>
        n.name === config.self ? { ...n, roles: ["member"] as Array<"member"> } : n,
      ),
    };
    expect(await fails(admitHub(member, hub, "me@example.com"))).toContain("is not an authority");
    expect(await fails(hostMcp(member, { ...hub, mcp: true }))).toContain("is not an authority");
    expect(head()).toBe(before);

    // Review B-11: an edit of the user's own is never committed along.
    const fleetFile = join(repo, "t3-fleet.toml");
    const own = fs.readFileSync(fleetFile, "utf8");
    fs.writeFileSync(fleetFile, `${own}\n# my own note\n`);
    expect(await fails(admitHub(config, hub, "me@example.com"))).toContain(
      "uncommitted changes to t3-fleet.toml",
    );
    expect(fs.readFileSync(fleetFile, "utf8")).toContain("# my own note");
    expect(head()).toBe(before);
    fs.writeFileSync(fleetFile, own);

    const admitted = await run(admitHub(config, { ...hub, mcp: true }, "me@example.com"));
    expect(admitted.lines.join("\n")).toContain("committed and pushed");
    expect(admitted.lines.join("\n")).toContain("opens for me@example.com");
    expect(admitted.added).toEqual({ node: true, relay: true, ui: true, token: true });
    expect(show("nodes/hub.toml")).toMatch(/roles = \["member", "relay"\]/);
    expect(show("nodes/hub.toml")).toContain('ssh = "me@hub"');
    expect(show("t3-fleet.toml")).toContain('url = "https://hub.tailnet.ts.net:8399"');
    expect(show("t3-fleet.toml")).toMatch(/\[ui\]\nallow = \["me@example\.com"\]/);
    expect(await run(readSecrets(repo))).toMatch(/^T3_FLEET_RELAY_TOKEN=[0-9a-f]{64}$/m);
    const mcpOf = () =>
      (parseToml(show("t3-fleet.toml")) as { defaults: { mcp: Record<string, unknown> } }).defaults
        .mcp;
    // Review B-3: admission never moves the machines' MCP servers, even with MCP hosting asked for.
    expect(mcpOf()["hub"]).toBeUndefined();
    expect(mcpOf()["gateway"]).toBeUndefined();
    expect((await run(admitHub(await run(loadConfig), hub, "someone@example.com"))).lines).toEqual([
      "hub is in the fleet already",
    ]);

    // Review B-3: abandoned, what admission added is taken out again, as new commits.
    const undone = await run(undoAdmission({ ...hub, admitted: admitted.added }));
    expect(undone.join("\n")).toContain("took hub out of the fleet");
    expect(undone.join("\n")).toContain("took out [relay], [ui], T3_FLEET_RELAY_TOKEN");
    expect(() => show("nodes/hub.toml")).toThrow();
    const after = parseToml(show("t3-fleet.toml")) as Record<string, unknown>;
    expect(after["relay"]).toBeUndefined();
    expect(after["ui"]).toBeUndefined();
    expect(await run(readSecrets(repo))).not.toContain("T3_FLEET_RELAY_TOKEN");

    // Admitted again; [defaults.mcp] only through hostMcp, which bringUp calls once the hub synced.
    await run(admitHub(await run(loadConfig), { ...hub, mcp: true }, "me@example.com"));
    expect(mcpOf()["hub"]).toBeUndefined();
    const hosted = await run(hostMcp(await run(loadConfig), { ...hub, mcp: true }));
    expect(hosted[0]).toMatch(
      /^\[defaults\.mcp\] hub in t3-fleet\.toml: your MCP servers run on hub/,
    );
    expect(mcpOf()).toMatchObject({ hub: true, gateway: "https://hub.tailnet.ts.net:8399" });
    expect(await run(hostMcp(await run(loadConfig), { ...hub, mcp: true }))).toEqual([
      "your MCP servers run on hub already",
    ]);
    expect(
      await fails(admitHub(await run(loadConfig), { ...hub, relayUrl: null, mcp: true })),
    ).toContain("no relay URL");
  });

  it("approves unattended only the hub's own proposed secrets, never a node file (review A-F1)", async () => {
    const scratch = fs.mkdtempSync(join(tmpdir(), "t3-fleet-onboarding-"));
    const g = (...args: Array<string>) =>
      execFileSync("git", ["-C", scratch, ...args], { encoding: "utf8" }).trim();
    g("init", "-q", "-b", "main");
    fs.mkdirSync(join(scratch, "nodes"));
    fs.writeFileSync(join(scratch, "nodes/hub.toml"), 'roles = ["member", "relay"]\n');
    g("add", ".");
    g("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    const commit = (change: () => void) => {
      g("checkout", "-q", "main");
      g("checkout", "-q", "-B", "proposal");
      change();
      g("add", "-A");
      g("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "proposal");
      return g("rev-parse", "HEAD");
    };
    const secretsOnly = commit(() => {
      fs.mkdirSync(join(scratch, "secrets-proposed"), { recursive: true });
      fs.writeFileSync(join(scratch, "secrets-proposed/hub.env.age"), "age\n");
    });
    expect(await run(onboardingOnly(scratch, "hub", secretsOnly))).toBe(true);
    // The review's repro: the node file making itself an authority, under the old path rule.
    const promotion = commit(() =>
      fs.writeFileSync(join(scratch, "nodes/hub.toml"), 'roles = ["authority", "relay"]\n'),
    );
    expect(await run(onboardingOnly(scratch, "hub", promotion))).toBe(false);
    const both = commit(() => {
      fs.mkdirSync(join(scratch, "secrets-proposed"), { recursive: true });
      fs.writeFileSync(join(scratch, "secrets-proposed/hub.env.age"), "age\n");
      fs.writeFileSync(join(scratch, "nodes/hub.toml"), 'roles = ["member", "relay"]\nssh = "x"\n');
    });
    expect(await run(onboardingOnly(scratch, "hub", both))).toBe(false);
    const link = commit(() => {
      fs.mkdirSync(join(scratch, "secrets-proposed"), { recursive: true });
      fs.symlinkSync("../nodes/hub.toml", join(scratch, "secrets-proposed/hub.env.age"));
    });
    expect(await run(onboardingOnly(scratch, "hub", link))).toBe(false);
    const another = commit(() => {
      fs.mkdirSync(join(scratch, "secrets-proposed"), { recursive: true });
      fs.writeFileSync(join(scratch, "secrets-proposed/desk.env.age"), "age\n");
    });
    expect(await run(onboardingOnly(scratch, "hub", another))).toBe(false);
  });

  it("invites with the line `t3-fleet invite` prints, committing the node once", async () => {
    const wizard = await engine();
    const first = await run(wizard.invite("desk"));
    expect(first.command).toMatch(/\| sh -s -- setup .*remote\.git desk$/);
    const commits = git("rev-list", "--count", "HEAD");
    expect(await run(wizard.invite("desk"))).toEqual(first);
    expect(git("rev-list", "--count", "HEAD")).toBe(commits);
    expect(await fails(wizard.invite("laptop"))).toContain("is this machine");
  });

  it("never sets up a hub from a member, at plan, resume or bring-up (review A-F2)", async () => {
    const wizard = await engine();
    const nodeFile = join(repo, "nodes/laptop.toml");
    const own = fs.readFileSync(nodeFile, "utf8");
    fs.writeFileSync(nodeFile, own.replace(/^roles = .*$/m, 'roles = ["member"]'));
    git("commit", "-qam", "laptop is a member here");
    try {
      const hub = { ssh: "me@hub", node: "hub", mcp: false };
      expect(
        await fails(wizard.plan({ ...request, repo: { kind: "url", url: bare }, hub })),
      ).toContain("laptop is not an authority");
      const saved = { ...hub, relayUrl: null, error: null };
      await run(writeHub(home, saved));
      expect(await fails(wizard.apply({ kind: "resume" }))).toContain("is not an authority");
      const steps: Array<string> = [];
      expect(
        await fails(bringUp(saved, (t) => Effect.sync(() => void steps.push(t)), home)),
      ).toContain("is not an authority");
      expect(steps).toEqual([]);
    } finally {
      await run(dropHub(home));
      git("reset", "-q", "--hard", "HEAD~1");
    }
  });

  it("refuses to join a repository that is not a fleet's (review B-10)", async () => {
    const other = fs.mkdtempSync(join(tmpdir(), "t3-fleet-not-a-fleet-"));
    const readme = join(other, "readme.git");
    const work = join(other, "work");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", readme]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    fs.writeFileSync(join(work, "README.md"), "# notes\n");
    execFileSync("git", ["-C", work, "add", "."]);
    execFileSync("git", ["-C", work, "commit", "-qm", "readme"]);
    execFileSync("git", ["-C", work, "push", "-q", readme, "main"]);
    const fresh = join(other, "home");
    fs.mkdirSync(fresh);
    fs.copyFileSync(join(home, ".gitconfig"), join(fresh, ".gitconfig"));
    process.env["HOME"] = fresh;
    try {
      const wizard = await engine();
      expect(
        await fails(wizard.plan({ ...request, repo: { kind: "url", url: readme }, node: "desk" })),
      ).toContain("is not a fleet's repository: it has no t3-fleet.toml");
    } finally {
      process.env["HOME"] = home;
    }
  });

  it("applies a saved run in one process at a time (review B-12)", async () => {
    const wizard = await engine();
    const lock = runLockPath(home);
    fs.mkdirSync(lock, { recursive: true });
    // Another live process holds it: the test runner's parent.
    fs.writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.ppid, start: 0, token: "elsewhere" }),
    );
    try {
      expect(await run(runningElsewhere(home))).toBe(true);
      expect(await fails(wizard.apply({ kind: "resume" }))).toBe(RUN_ELSEWHERE);
      expect(await fails(wizard.apply({ kind: "abandon" }))).toBe(RUN_ELSEWHERE);
      expect(await fails(withRunLock(home, Effect.succeed("ran")))).toBe(RUN_ELSEWHERE);
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    expect(await run(withRunLock(home, Effect.succeed("ran")))).toBe("ran");
    expect(await run(runningElsewhere(home))).toBe(false);
  });
});
