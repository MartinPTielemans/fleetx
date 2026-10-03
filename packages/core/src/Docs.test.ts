// A plain test reading files; no Effect runtime involved.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

/** Every finding key the runtime, engine and models areas can produce must be documented. */
describe("docs/troubleshooting.md", () => {
  const doc = readFileSync(new URL("../../../docs/troubleshooting.md", import.meta.url), "utf8");
  const areas = new URL("./areas/", import.meta.url);
  for (const file of readdirSync(areas).filter((f) => f === "Runtime.ts" || f === "Engine.ts" || f === "Models.ts")) {
    const source = readFileSync(new URL(file, areas), "utf8");
    for (const [, key] of source.matchAll(/key: "([a-z0-9-]+)"/g)) {
      it(`explains ${key}`, () => {
        expect(doc).toContain(`\`${key}\``);
      });
    }
  }
  it("explains claude-logged-out", () => {
    expect(doc).toContain("`claude-logged-out`");
  });
});
