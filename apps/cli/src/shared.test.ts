// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { bundleFor, fixPlan } from "./shared.ts";

describe("the bundle this runs from", () => {
  it("is this file under any name, and the last build when this is source", () => {
    expect(bundleFor("/repo/apps/cli/dist/bin.mjs", join)).toBe("/repo/apps/cli/dist/bin.mjs");
    expect(bundleFor("/home/me/.local/share/t3-fleet/t3-fleet", join)).toBe(
      "/home/me/.local/share/t3-fleet/t3-fleet",
    );
    expect(bundleFor("/opt/t3-fleet/bin.js", join)).toBe("/opt/t3-fleet/bin.js");
    expect(bundleFor("/repo/apps/cli/src/shared.ts", join)).toBe("/repo/apps/cli/dist/bin.mjs");
  });
});

describe("t3-fleet fix --area", () => {
  it("narrows the findings that need a decision too", () => {
    const finding = (area: string, fix?: { safe: boolean }) => ({
      node: "box",
      key: `${area}-x`,
      severity: "warn" as const,
      area,
      title: `${area} thing`,
      ...(fix === undefined ? {} : { fix: { command: "true", ...fix } }),
    });
    const all = [
      finding("instructions", { safe: true }),
      finding("mcp"),
      finding("mcp", { safe: false }),
    ];
    const plan = fixPlan(all, { safe: true, areas: ["instructions"] });
    expect(plan.fixes.map((f) => f.area)).toEqual(["instructions"]);
    expect(plan.findings.map((f) => f.area)).toEqual(["instructions"]);
    expect(plan.skipped).toEqual([]);
    expect(fixPlan(all, { safe: true, areas: [] }).skipped.map((f) => f.area)).toEqual(["mcp"]);
  });
});
