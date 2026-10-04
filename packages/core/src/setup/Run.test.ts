// A whole first-machine setup in a temporary home, against a bare repository
// standing in for GitHub: it stops part-way, and resumes from what was saved.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ProbeServices } from "../Area.ts";
import { readSecrets, setVar } from "../Secrets.ts";
import {
  commitPaths,
  persistable,
  restored,
  secretsToStore,
  setupSteps,
  type SetupInput,
} from "./Apply.ts";
import { EMPTY_FLEET, type Actions } from "./Plan.ts";
import { uncommittedFleetFiles } from "./Repo.ts";
import { loadRunSecrets, saveRunSecrets } from "./State.ts";

const services = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const run = <A, E>(effect: Effect.Effect<A, E, ProbeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(services)));

const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-run-"));
const repo = join(home, "fleet");
const bare = join(home, "remote.git");
const realHome = process.env["HOME"];
beforeAll(() => {
  process.env["HOME"] = home;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  fs.mkdirSync(join(home, ".agents/skills/demo"), { recursive: true });
  fs.writeFileSync(join(home, ".agents/skills/demo/SKILL.md"), "---\nname: demo\n---\nhi\n");
});
afterAll(() => {
  process.env["HOME"] = realHome;
});

const KEY = "ctx-SEKRIT-value-0123456789";
const RELAY = "relay-SEKRIT-0123456789abcdef";
const actions = (): Actions => ({
  skills: [{ name: "demo", from: join(home, ".agents/skills/demo"), source: null }],
  servers: [
    {
      name: "ctx",
      definition: { kind: "stdio", command: "npx", args: ["ctx", "--api-key", "$CTX_API_KEY"] },
      scope: "fleet",
    },
  ],
  serversHereOnly: [],
  ignored: [{ name: "node_repl", why: "an app's own server" }],
  instructions: [],
  instructionsHereOnly: [],
  links: [{ path: join(home, ".agents/skills/demo"), link: join(repo, "skills/demo") }],
  secrets: [{ name: "CTX_API_KEY", value: KEY, where: "ctx: arg --api-key" }],
});
const input = (): SetupInput => ({
  mode: "first",
  node: "laptop",
  checkout: repo,
  join: null,
  commits: true,
  actions: actions(),
  handed: [],
  extras: { relay: { url: null, token: RELAY }, models: null, t3: false },
  timer: { works: false, why: "no systemd here" },
  remote: { url: bare },
  now: 1,
});
const hooks = { t3Connect: Effect.succeed(""), raw: { claude: {}, codex: {} } };

/** Run the steps not done yet, up to the first sync; the ids done, and the failure if one failed. */
const runSteps = async (setup: SetupInput, done: Array<string>) => {
  for (const step of setupSteps(setup, hooks)) {
    if (done.includes(step.id) || step.id === "sync") continue;
    const result = await run(Effect.result(step.run));
    if (result._tag === "Failure") return result.failure;
    done.push(step.id);
  }
  return null;
};

describe("a setup that stops part-way", () => {
  it("resumes from what was saved, with every secret, and no value outside the encrypted files", async () => {
    const first = input();
    // Saved before the first step: the run without values, the values encrypted beside it.
    const saved = JSON.parse(JSON.stringify(persistable(first))) as SetupInput;
    let plain = "";
    for (const s of secretsToStore(first)) plain = setVar(plain, s.name, s.value);
    await run(saveRunSecrets(home, 7, plain));
    expect(JSON.stringify(saved)).not.toContain("SEKRIT");

    const done: Array<string> = [];
    for (const step of setupSteps(first, hooks)) {
      if (step.id === "content") break;
      expect(await run(Effect.result(step.run))).toMatchObject({ _tag: "Success" });
      done.push(step.id);
    }
    // Someone writes a fleet file TomlEdit cannot edit: content fails.
    const fleetFile = join(repo, "t3-fleet.toml");
    const good = fs.readFileSync(fleetFile, "utf8");
    fs.writeFileSync(fleetFile, `${good}\n[defaults]\nmcp = { servers = [] }\n`);
    expect(await runSteps(first, done)).toContain("writing the repo");

    // Resume: nothing is planned again; the saved run gets its values back.
    fs.writeFileSync(fleetFile, good);
    const back = restored(saved, await run(loadRunSecrets(home, 7)));
    if ("missing" in back) return expect.unreachable();
    const resumed = back;
    expect(resumed.actions.secrets).toEqual(first.actions.secrets);
    expect(resumed.extras.relay?.token).toBe(RELAY);
    expect(await runSteps(resumed, done)).toBeNull();

    const secrets = await run(readSecrets(repo));
    expect(secrets).toContain(`CTX_API_KEY=${KEY}`);
    expect(secrets).toContain(`T3_FLEET_RELAY_TOKEN=${RELAY}`);
    const history = execFileSync("git", ["-C", bare, "log", "-p", "--all"], { encoding: "utf8" });
    expect(history).toContain('"$CTX_API_KEY"');
    expect(history).not.toContain("SEKRIT");
    const node = fs.readFileSync(join(repo, "nodes/laptop.toml"), "utf8");
    expect(node).toContain('"ignore.add" = ["node_repl"]');
    expect(node).toContain("timer = false");
    expect(fs.readlinkSync(join(home, ".agents/skills/demo"))).toBe(join(repo, "skills/demo"));
  });

  it("commits only what the run wrote; an uncommitted edit stays where it is, unpublished", async () => {
    // Edits nobody committed, to the fleet's files and outside them.
    const ctx = join(repo, "mcp/ctx.json");
    const committed = fs.readFileSync(ctx, "utf8");
    fs.writeFileSync(ctx, committed.replace('"ctx"', '"ctx", "--draft-flag"'));
    fs.writeFileSync(join(repo, "nodes/other.toml"), 'roles = ["member"]\n');
    fs.writeFileSync(join(repo, "bootstrap.sh"), "#!/bin/sh\n");
    const dirty = await run(uncommittedFleetFiles(repo, "laptop", EMPTY_FLEET));
    expect(dirty).toEqual([" M mcp/ctx.json"]);
    // Paths as they are, not as git quotes them.
    fs.writeFileSync(join(repo, "mcp/a b é.json"), "{}\n");
    expect(await run(uncommittedFleetFiles(repo, "laptop", EMPTY_FLEET))).toEqual([
      " M mcp/ctx.json",
      "?? mcp/a b é.json",
    ]);
    fs.rmSync(join(repo, "mcp/a b é.json"));
    expect(await run(uncommittedFleetFiles(repo, "laptop", EMPTY_FLEET, ["mcp/ctx.json"]))).toEqual(
      [],
    );

    const again: SetupInput = {
      ...input(),
      mode: "again",
      actions: {
        ...actions(),
        skills: [],
        links: [],
        ignored: [],
        servers: [
          {
            name: "another",
            definition: { kind: "remote", url: "https://another.example/mcp" },
            scope: "fleet",
          },
        ],
        secrets: [],
      },
      extras: { relay: null, models: null, t3: false },
      now: 2,
    };
    expect(commitPaths(again)).not.toContain("mcp");
    expect(await runSteps(again, ["snapshot", "repo"])).toBeNull();
    const show = (file: string) =>
      execFileSync("git", ["-C", bare, "show", `main:${file}`], { encoding: "utf8" });
    expect(show("mcp/another.json")).toContain("another.example");
    expect(show("mcp/ctx.json")).toBe(committed);
    expect(() => show("nodes/other.toml")).toThrow();
    expect(fs.readFileSync(ctx, "utf8")).toContain("--draft-flag");
    expect(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" })).toBe(
      " M mcp/ctx.json\n?? bootstrap.sh\n?? nodes/other.toml\n",
    );
    fs.writeFileSync(ctx, committed);
    fs.rmSync(join(repo, "nodes/other.toml"));
    fs.rmSync(join(repo, "bootstrap.sh"));
  });

  it("refuses to resume without its values: missing, another run's, or incomplete", async () => {
    const stopped = await run(Effect.flip(loadRunSecrets(home, 8)));
    expect(stopped).toContain("belongs to another run");
    expect(stopped).toContain("t3-fleet setup --abandon");
    const saved = persistable(input());
    expect(restored(saved, "# run 7\nCTX_API_KEY=x\n")).toEqual({
      missing: ["T3_FLEET_RELAY_TOKEN"],
    });
    expect(restored(saved, "# run 7\n")).toEqual({
      missing: ["CTX_API_KEY", "T3_FLEET_RELAY_TOKEN"],
    });
    fs.rmSync(join(home, ".local/state/t3-fleet/setup/secrets.age"));
    expect(await run(Effect.flip(loadRunSecrets(home, 7)))).toContain("is missing");
  });
});
