// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { describe, expect, it } from "vite-plus/test";

import { AREAS } from "./Areas.ts";
import { diagnose } from "./Diagnose.ts";
import type { MachineObservation } from "./Observation.ts";
import { loadAreas } from "./Plugins.ts";
import { observeAreas } from "./Probe.ts";

const examples = new URL("../../../examples", import.meta.url).pathname;

describe("plugins", () => {
  it("loads an area from the config repo and reports one that cannot load", async () => {
    const { areas, problems } = await Effect.runPromise(
      loadAreas(examples, ["plugins/brew.mjs", "plugins/missing.mjs"]).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    const brew = areas.find((a) => a.id === "brew");
    expect(brew).toBeDefined();
    expect(problems).toEqual([
      {
        plugin: "plugins/missing.mjs",
        title: expect.stringMatching(/^plugin plugins\/missing\.mjs cannot load: /),
      },
    ]);
    const findings = brew?.diagnose({
      node: "laptop",
      desired: ["gh", "jq"],
      observed: { brew: true, installed: ["gh"] },
      fleet: [],
      authority: null,
    });
    expect(findings?.[0]?.fix?.command).toBe("brew install jq");
  });
});

describe("a plugin that fails", () => {
  const repo = mkdtempSync(join(tmpdir(), "t3f-plugins-"));
  mkdirSync(join(repo, "plugins"));
  const area = (id: string, observe: string, diagnose: string) =>
    `export default ({ defineArea, Effect, Schema }) => defineArea({ id: "${id}", description: "", desired: Schema.Unknown, observed: Schema.Struct({ ok: Schema.Boolean }), observe: () => ${observe}, diagnose: ${diagnose} });`;
  writeFileSync(
    join(repo, "plugins/fine.mjs"),
    area(
      "fine",
      "Effect.succeed({ ok: true })",
      `({ node }) => [{ node, key: "fine-seen", severity: "info", area: "fine", title: "fine" }]`,
    ),
  );
  writeFileSync(
    join(repo, "plugins/observe.mjs"),
    area(
      "observe-throws",
      `Effect.sync(() => { throw new Error("brew is not installed") })`,
      "() => []",
    ),
  );
  writeFileSync(
    join(repo, "plugins/shape.mjs"),
    area("wrong-shape", `Effect.succeed({ ok: "yes" })`, "() => []"),
  );
  writeFileSync(
    join(repo, "plugins/diagnose.mjs"),
    area(
      "diagnose-throws",
      "Effect.succeed({ ok: true })",
      `() => { throw new Error("no rules") }`,
    ),
  );
  writeFileSync(
    join(repo, "plugins/factory.mjs"),
    `export default () => { throw new Error("kit too old") };`,
  );
  const plugins = [
    "plugins/fine.mjs",
    "plugins/observe.mjs",
    "plugins/shape.mjs",
    "plugins/diagnose.mjs",
    "plugins/factory.mjs",
  ];

  const run = Effect.gen(function* () {
    const all = yield* loadAreas(repo, plugins);
    // The plugins' areas only: the built-in ones would look at this machine.
    const loaded = { areas: all.areas.filter((a) => !AREAS.includes(a)), problems: all.problems };
    const areas = yield* observeAreas(loaded, {}, { home: repo, checkout: repo, env: {} });
    return { loaded, areas };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make(() => Effect.die("no network in this test")),
        ),
      ),
    ),
  );

  it("is reported with the others still observed and diagnosed", async () => {
    const { loaded, areas } = await Effect.runPromise(run);
    expect(loaded.areas.map((a) => a.id)).toEqual([
      "fine",
      "observe-throws",
      "wrong-shape",
      "diagnose-throws",
    ]);
    expect(areas["fine"]).toEqual({ ok: true });
    expect(areas["observe-throws"]).toEqual({
      unreadable: expect.stringContaining("brew is not installed"),
    });
    expect(areas["wrong-shape"]).toEqual({
      unreadable: expect.stringContaining("does not match its schema"),
    });

    const node = {
      name: "mac",
      ssh: null,
      roles: ["member" as const],
      profiles: [],
      tailnet: null,
      settings: { table: {}, provenance: new Map() },
    };
    const all = diagnose(
      [{ node, ok: true, observation: { ...stubMachine, areas }, ms: 0 }],
      { agents: { claude: null, codex: null }, t3: {} },
      {},
      [node],
      loaded.areas,
    ).filter((f) => f.area !== "t3" && f.area !== "agents" && f.area !== "sync");
    const byKey = Object.fromEntries(all.map((f) => [f.key, f]));
    expect(byKey["fine-seen"]).toBeDefined();
    expect(byKey["plugin-failed-plugins/factory.mjs"]?.title).toBe(
      "plugin plugins/factory.mjs failed while making its area: kit too old",
    );
    expect(byKey["observe-throws-unreadable"]).toMatchObject({
      severity: "error",
      detail: expect.stringContaining("brew is not installed"),
    });
    expect(byKey["wrong-shape-unreadable"]).toBeDefined();
    expect(byKey["diagnose-throws-unreadable"]).toMatchObject({
      detail: "its diagnosis failed: no rules",
    });
  });
});

describe("a plugin in a path a file:// URL must escape", () => {
  // In Node itself: the test runner resolves dynamic imports its own way.
  it("loads", () => {
    const repo = mkdtempSync(join(tmpdir(), "t3f-plugins #1 100% "));
    mkdirSync(join(repo, "plugins"));
    writeFileSync(
      join(repo, "plugins/a.mjs"),
      `export default ({ defineArea, Effect, Schema }) => defineArea({ id: "a", description: "", desired: Schema.Unknown, observed: Schema.Unknown, observe: () => Effect.succeed(1), diagnose: () => [] });`,
    );
    const script = [
      `import * as NodeServices from "@effect/platform-node/NodeServices";`,
      `import * as Effect from "effect/Effect";`,
      `import { loadAreas } from ${JSON.stringify(new URL("./Plugins.ts", import.meta.url).href)};`,
      `const { areas, problems } = await Effect.runPromise(loadAreas(process.argv[1], ["plugins/a.mjs"]).pipe(Effect.provide(NodeServices.layer)));`,
      `console.log(JSON.stringify({ loaded: areas.some((a) => a.id === "a"), problems }));`,
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, repo], {
      cwd: new URL("..", import.meta.url).pathname,
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual({ loaded: true, problems: [] });
  });
});

const stubMachine: MachineObservation = {
  protocol: 5,
  hostname: "h",
  platform: "darwin",
  arch: "arm64",
  user: "u",
  observedAt: 0,
  agents: [],
  t3: {
    runtime: null,
    descriptor: null,
    installedVersion: null,
    runtimeBinary: null,
    serverPath: null,
    providers: [],
    access: null,
    problems: [],
  },
  providerAuth: [],
  proxy: null,
  areas: {},
  lastSync: null,
};
