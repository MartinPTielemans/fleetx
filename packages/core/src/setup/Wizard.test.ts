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
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ProbeServices } from "../Area.ts";
import { loadConfig } from "../Config.ts";
import { readSecrets } from "../Secrets.ts";
import type { UiSetupPlanRequest } from "../SetupApi.ts";
import { admitHub, ownFilesOnly } from "./Hub.ts";
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

const request: UiSetupPlanRequest = {
  repo: { kind: "local" },
  node: "laptop",
  hub: null,
  extras: [],
};

const engine = () =>
  run(Wizard.make({ t3Connect: Effect.fail("no T3 here"), scratchDir: join(home, "scratch") }));

describe("the setup wizard's engine", () => {
  it("plans a first machine, refuses a plan gone stale, and applies one as a setup job", async () => {
    const wizard = await engine();
    expect(await run(wizard.state)).toMatchObject({ stage: "fresh", unfinished: null, hub: null });
    expect(await fails(wizard.plan({ ...request, hub: { ssh: "me@box", node: "box" } }))).toContain(
      "the hub joins through the fleet's repository",
    );
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
    expect(fs.readlinkSync(join(home, ".agents/skills/demo"))).toBe(join(repo, "skills/demo"));
    expect(fs.existsSync(join(home, "scratch"))).toBe(false);
    expect(await run(wizard.state)).toMatchObject({ stage: "member", suggestedName: "laptop" });
    expect(await fails(wizard.apply({ kind: "resume" }))).toContain("no unfinished setup");
  });

  it("admits the hub on the authority: its node file, [relay], a relay token; once", async () => {
    git("remote", "add", "origin", bare);
    git("push", "-q", "-u", "origin", "main");
    const config = await run(loadConfig);
    const hub = { node: "box", ssh: "me@box", relayUrl: "https://box.ts.net:8399", error: null };
    const lines = await run(admitHub(config, hub));
    expect(lines.join("\n")).toContain("committed and pushed");
    const show = (file: string) =>
      execFileSync("git", ["-C", bare, "show", `main:${file}`], { encoding: "utf8" });
    expect(show("nodes/box.toml")).toMatch(/roles = \["member", "relay"\]/);
    expect(show("nodes/box.toml")).toContain('ssh = "me@box"');
    expect(show("t3-fleet.toml")).toContain('url = "https://box.ts.net:8399"');
    expect(await run(readSecrets(repo))).toMatch(/^T3_FLEET_RELAY_TOKEN=[0-9a-f]{64}$/m);
    expect(await run(admitHub(await run(loadConfig), hub))).toEqual([
      "box is in the fleet already",
    ]);
    expect(ownFilesOnly("box", ["nodes/box.toml", "secrets-proposed/box.env.age"])).toBe(true);
    expect(ownFilesOnly("box", ["nodes/box.toml", "skills/x/SKILL.md"])).toBe(false);
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
});
