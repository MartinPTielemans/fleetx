// A plain test running the probe's shell in a scratch home; no ssh involved.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  // @effect-diagnostics-next-line nodeBuiltinImport:off
} from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { BUNDLE_FILE, SHARE_DIR } from "./Names.ts";
import { encodeSettings, installedProbe, NOT_INSTALLED, probeRemote } from "./Remote.ts";

const run = (home: string, script: string) => {
  try {
    return {
      code: 0,
      stdout: execFileSync("bash", ["-c", script], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      }),
    };
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
    expect(out).toEqual({
      code: 0,
      stdout: `${JSON.stringify(["probe", encodeSettings(settings)])}\n`,
    });
  });

  it("runs a private copy of what it hashed, and removes it after", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fleet-home-"));
    const where = "console.log(process.argv[1])\n";
    mkdirSync(join(home, SHARE_DIR), { recursive: true });
    writeFileSync(join(home, SHARE_DIR, BUNDLE_FILE), where);
    const out = run(
      home,
      installedProbe(createHash("sha256").update(where).digest("hex"), settings),
    );
    expect(out.code).toBe(0);
    const ran = out.stdout.trim();
    expect(ran.endsWith(`/${BUNDLE_FILE}`)).toBe(true);
    expect(ran).not.toBe(join(home, SHARE_DIR, BUNDLE_FILE));
    expect(existsSync(ran)).toBe(false);
  });

  it("asks for the bundle when nothing, or another build, is installed", () => {
    const home = mkdtempSync(join(tmpdir(), "t3-fleet-home-"));
    expect(run(home, installedProbe(engine, settings)).code).toBe(NOT_INSTALLED);
    mkdirSync(join(home, SHARE_DIR), { recursive: true });
    writeFileSync(join(home, SHARE_DIR, BUNDLE_FILE), `${bundle}// another build\n`);
    expect(run(home, installedProbe(engine, settings)).code).toBe(NOT_INSTALLED);
  });
});

/**
 * A fake ssh on PATH: each call takes the next exit status from `plan`, logs
 * whether it was the installed-copy probe (`-n`) or the streamed bundle, and
 * prints `out` when it succeeds. "sleep" waits past the test's timeout.
 */
describe("probeRemote", () => {
  let dir = "";
  let path: string | undefined;
  const observation = (installed: string | null) => ({
    protocol: 5,
    hostname: "box",
    platform: "linux",
    arch: "x64",
    user: "u",
    observedAt: 1,
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
    areas: { engine: { installed } },
    lastSync: null,
  });
  const plan = (steps: ReadonlyArray<string>, out: unknown = observation(null)) => {
    writeFileSync(join(dir, "plan"), `${steps.join("\n")}\n`);
    writeFileSync(join(dir, "out"), `${JSON.stringify(out)}\n`);
    writeFileSync(join(dir, "log"), "");
  };
  const calls = () =>
    readFileSync(join(dir, "log"), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l !== "");
  const probe = (ssh: string) =>
    Effect.runPromise(
      probeRemote(ssh, "bundle", {}, "engine-sha", 1).pipe(
        Effect.result,
        Effect.provide(NodeServices.layer),
      ),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "t3-fleet-ssh-"));
    writeFileSync(
      join(dir, "ssh"),
      `#!/bin/bash
d=${JSON.stringify(dir)}
step=$(head -n 1 "$d/plan"); tail -n +2 "$d/plan" > "$d/plan.next"; mv "$d/plan.next" "$d/plan"
case " $* " in *" -n "*) echo installed >> "$d/log" ;; *) cat > /dev/null; echo bundle >> "$d/log" ;; esac
[ "$step" = sleep ] && sleep 5
[ "$step" = 0 ] && cat "$d/out"
exit "$step"
`,
    );
    chmodSync(join(dir, "ssh"), 0o755);
    path = process.env["PATH"];
    process.env["PATH"] = `${dir}:${path ?? ""}`;
  });
  afterEach(() => {
    process.env["PATH"] = path;
  });

  it("streams the bundle when the installed copy is not this build, then skips the copy", async () => {
    plan([String(NOT_INSTALLED), "0", "0"]);
    expect((await probe("box-97"))._tag).toBe("Success");
    expect(calls()).toEqual(["installed", "bundle"]);
    expect((await probe("box-97"))._tag).toBe("Success");
    expect(calls()).toEqual(["installed", "bundle", "bundle"]);
  });

  it("does not ask an unreachable node twice", async () => {
    plan(["255"]);
    const result = await probe("box-255");
    expect(result._tag).toBe("Failure");
    expect(calls()).toEqual(["installed"]);
  });

  it("does not ask a node that timed out twice", async () => {
    plan(["sleep"]);
    const result = await probe("box-slow");
    expect(result).toMatchObject({ _tag: "Failure", failure: "no answer from box-slow within 1s" });
    expect(calls()).toEqual(["installed"]);
  }, 15_000);

  it("tries the installed copy again once an observation shows the build installed", async () => {
    plan([String(NOT_INSTALLED), "0", "0", "0"], observation("engine-sha"));
    await probe("box-fixed");
    await probe("box-fixed");
    expect(calls()).toEqual(["installed", "bundle", "installed"]);
  });
});
