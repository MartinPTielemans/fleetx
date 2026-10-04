import { describe, expect, it } from "vite-plus/test";

import { ENGINE_INSTALL } from "./areas/Engine.ts";
import type { Finding, Fix } from "./Diagnose.ts";
import { inRunOrder } from "./Fix.ts";

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
