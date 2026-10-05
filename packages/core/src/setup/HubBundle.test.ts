// The build the hub is sent: exactly the one the wizard started with, checked again where it lands (review A-F5).
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { installEngineScript } from "../Fix.ts";
import { sha256 } from "../Hash.ts";
import { BUNDLE_FILE, SHARE_DIR } from "../Names.ts";
import { bundleAt } from "./Remote.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const fails = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)));

const MARKER = '/* t3-fleet build {"version":"1.0.0","commit":"abc","time":"t"} */\n';

describe("the build sent to the hub", () => {
  it("is the one first read, and a file changed since is refused even with the same marker", async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "t3-fleet-bundle-"));
    const file = join(dir, "bin.mjs");
    fs.writeFileSync(file, `${MARKER}console.log("the real build")\n`);
    const first = await run(bundleAt(file));
    expect(first.digest).toBe(await sha256(`${MARKER}console.log("the real build")\n`));
    expect(await run(bundleAt(file))).toEqual(first);
    fs.writeFileSync(file, `${MARKER}console.log("WIZRVA_REPLACED_BUILD_EXECUTED")\n`);
    expect(await fails(bundleAt(file))).toContain("changed since the wizard started");
  });

  it("is installed only when what arrived has its digest", async () => {
    const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-bundle-home-"));
    const bundle = `${MARKER}console.log("the real build")\n`;
    const install = (digest: string) => {
      try {
        execFileSync("bash", ["-s"], {
          input: installEngineScript(bundle, digest).replace(/systemctl|launchctl/g, "true"),
          env: { ...process.env, HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    const installed = join(home, SHARE_DIR, BUNDLE_FILE);
    expect(install("0".repeat(64))).not.toBe(0);
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(`${installed}.tmp`)).toBe(false);
    expect(install(await sha256(bundle))).toBe(0);
    expect(fs.readFileSync(installed, "utf8")).toBe(bundle);
  });
});
