import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { loadAreas } from "./Plugins.ts";

const examples = new URL("../../../examples", import.meta.url).pathname;

describe("plugins", () => {
  it("loads an area from the config repo and reports one that cannot load", async () => {
    const { areas, problems } = await Effect.runPromise(
      loadAreas(examples, ["plugins/brew.mjs", "plugins/missing.mjs"]).pipe(Effect.provide(NodeServices.layer)),
    );
    const brew = areas.find((a) => a.id === "brew");
    expect(brew).toBeDefined();
    expect(problems).toEqual(["plugin plugins/missing.mjs: cannot load (it must export a default function)"]);
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
