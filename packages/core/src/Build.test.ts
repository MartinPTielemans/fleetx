import { describe, expect, it } from "vite-plus/test";

import { buildMarker, buildOf, compareBuilds, describeBuild } from "./Build.ts";

const build = (version: string, builtAt: number, commit: string | null = "abc1234") => ({ version, builtAt, commit });

describe("buildOf", () => {
  it("reads the identity back out of a bundle's text", () => {
    const bundle = `#!/usr/bin/env node\nconst a=1;var B="${buildMarker(build("0.6.2", 1759579200000, "abc1234-dirty"))}";console.log(B)`;
    expect(buildOf(bundle)).toEqual(build("0.6.2", 1759579200000, "abc1234-dirty"));
    expect(buildOf(`x='${buildMarker(build("1.0.0-rc.1", 5, null))}'`)).toEqual(build("1.0.0-rc.1", 5, null));
  });

  it("finds nothing in a build from before identities, nor in its own pattern", () => {
    expect(buildOf("console.log('fleetx 0.6.1')")).toBeNull();
    expect(buildOf(String.raw`new RegExp("t3-fleet-build:(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?):(\\d+):([0-9a-f]*)")`)).toBeNull();
  });
});

describe("compareBuilds", () => {
  it("orders by version, then by build time", () => {
    expect(compareBuilds(build("0.6.2", 1), build("0.6.1", 9))).toBeGreaterThan(0);
    expect(compareBuilds(build("0.10.0", 1), build("0.9.9", 1))).toBeGreaterThan(0);
    expect(compareBuilds(build("0.6.1", 1), build("0.6.1", 2))).toBeLessThan(0);
    expect(compareBuilds(build("1.0.0", 1), build("1.0.0-rc.1", 2))).toBeGreaterThan(0);
    expect(compareBuilds(build("0.6.1", 2), build("0.6.1", 2))).toBe(0);
    expect(compareBuilds(build("0.6.1", 2, "abc1234-dirty"), build("0.6.1", 1, "abc1234"))).toBeGreaterThan(0);
  });

  it("does not know which of one version's builds is newer when they come from different commits", () => {
    // An older branch, still 0.6.1, rebuilt today.
    expect(compareBuilds(build("0.6.1", 9, "old0001"), build("0.6.1", 1, "new0002"))).toBeNull();
    expect(compareBuilds(build("0.6.1", 9, null), build("0.6.1", 1, null))).toBeNull();
  });
});

describe("describeBuild", () => {
  it("says version, time and commit", () => {
    expect(describeBuild(build("0.6.1", Date.UTC(2026, 9, 4, 12, 0)))).toBe("0.6.1 built 2026-10-04 12:00 UTC (abc1234)");
  });
});
