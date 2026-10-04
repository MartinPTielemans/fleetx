import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { ENGINE_INSTALL } from "./areas/Engine.ts";
import type { Finding, Fix } from "./Diagnose.ts";
import type { Node } from "./Config.ts";
import { inRunOrder, runFix } from "./Fix.ts";

const finding = (key: string, command = `echo ${key}`): Finding & { readonly fix: Fix } => ({
  node: "box",
  key,
  severity: "warn",
  area: "engine",
  title: key,
  fix: { command, safe: false },
});

describe("inRunOrder", () => {
  it("installs this build, then moves fleetx's directories, before any unit starts a run", () => {
    const fixes = [
      finding("engine-timer"),
      finding("relay-listen"),
      finding("engine-legacy-dirs"),
      finding("engine-outdated", ENGINE_INSTALL),
      finding("models-service"),
    ];
    expect(inRunOrder(fixes).map((f) => f.key)).toEqual([
      "engine-outdated",
      "engine-legacy-dirs",
      "engine-timer",
      "relay-listen",
      "models-service",
    ]);
  });
});

describe("runFix", () => {
  it("refuses to install a build it was not given, instead of an empty file", async () => {
    const node = { name: "box", ssh: "box.invalid", roles: [], profiles: [], settings: { table: {}, sources: {} } } as unknown as Node;
    const outcome = await Effect.runPromise(runFix(node, finding("engine-outdated", ENGINE_INSTALL), "~/fleet", "").pipe(Effect.provide(NodeServices.layer)));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("no T3 Fleet build to install");
  });
});
