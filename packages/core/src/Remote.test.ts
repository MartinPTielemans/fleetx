// A plain test running the probe's shell in a scratch home; no ssh involved.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { BUNDLE_FILE, SHARE_DIR } from "./Names.ts";
import { encodeSettings, installedProbe, NOT_INSTALLED } from "./Remote.ts";

const run = (home: string, script: string) => {
  try {
    return { code: 0, stdout: execFileSync("bash", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" }) };
  } catch (error) {
    return { code: (error as { status: number }).status, stdout: "" };
  }
};

describe("installedProbe", () => {
  const bundle = "console.log(JSON.stringify(process.argv.slice(2)))\n";
  const engine = createHash("sha256").update(bundle).digest("hex");
  const settings = { node: "box" };

  it("runs the node's own copy when it is the wanted build", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fleet-home-"));
    mkdirSync(join(home, SHARE_DIR), { recursive: true });
    writeFileSync(join(home, SHARE_DIR, BUNDLE_FILE), bundle);
    const out = run(home, installedProbe(engine, settings));
    expect(out).toEqual({ code: 0, stdout: `${JSON.stringify(["probe", encodeSettings(settings)])}\n` });
  });

  it("asks for the bundle when nothing, or another build, is installed", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fleet-home-"));
    expect(run(home, installedProbe(engine, settings)).code).toBe(NOT_INSTALLED);
    mkdirSync(join(home, SHARE_DIR), { recursive: true });
    writeFileSync(join(home, SHARE_DIR, BUNDLE_FILE), `${bundle}// another build\n`);
    expect(run(home, installedProbe(engine, settings)).code).toBe(NOT_INSTALLED);
  });
});
