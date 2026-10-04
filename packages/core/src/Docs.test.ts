// A plain test reading files; no Effect runtime involved.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/** Every finding key the runtime, engine, mcp and models areas can produce must be documented. */
describe("docs/troubleshooting.md", () => {
  const doc = readFileSync(new URL("../../../docs/troubleshooting.md", import.meta.url), "utf8");
  const areas = new URL("./areas/", import.meta.url);
  for (const file of readdirSync(areas).filter(
    (f) => f === "Runtime.ts" || f === "Engine.ts" || f === "Mcp.ts" || f === "Models.ts",
  )) {
    const source = readFileSync(new URL(file, areas), "utf8");
    // Keys per server or instance are templates: `mcp-${s.name}-down` is documented as
    // `mcp-<name>-down`, `models-not-routed-${id}` as `models-not-routed-<instance>`.
    const slot = file === "Mcp.ts" ? "<name>" : "<instance>";
    const keys = [
      ...source.matchAll(/key: "([a-z0-9-]+)"/g),
      ...source.matchAll(/key: `([a-z0-9-]+)\$\{[^}]+\}([a-z0-9-]*)`/g),
    ].map((m) => (m.length > 2 && m[2] !== undefined ? `${m[1]}${slot}${m[2]}` : (m[1] ?? "")));
    for (const key of keys) {
      it(`explains ${key}`, () => {
        expect(doc).toContain(`\`${key}\``);
      });
    }
  }
  for (const key of [
    "provider-logged-out-<instance>",
    "provider-unhealthy-<instance>",
    "t3-access",
  ]) {
    it(`explains ${key}`, () => {
      expect(doc).toContain(`\`${key}\``);
    });
  }
});
