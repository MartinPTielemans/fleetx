// A plain test running a fix's shell; no Effect runtime involved.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { probeSettings, type Config } from "../Config.ts";
import { EngineArea } from "./Engine.ts";

const observed = (over: Record<string, unknown> = {}) => ({
  wanted: "abc",
  installed: "abc",
  local: null,
  platform: "linux",
  root: false,
  nodePath: "/usr/bin/node",
  timer: { installed: null, want: null, loaded: false },
  legacy: [],
  repoRenamed: false,
  ...over,
});

const repoNames = (fleet: ReadonlyArray<{ node: string; observed: ReturnType<typeof observed> }>, nodes: ReadonlyArray<string>) =>
  EngineArea.diagnose({
    node: "mac",
    desired: undefined,
    observed: fleet.find((e) => e.node === "mac")?.observed,
    fleet: fleet.map((e) => ({ ...e, desired: undefined })),
    authority: "mac",
    nodes,
  }).find((f) => f.key === "engine-repo-names");

describe("engine-repo-names", () => {
  it("offers the rename on the authority once every configured machine runs this build", () => {
    const ready = repoNames([{ node: "mac", observed: observed() }, { node: "box", observed: observed() }], ["mac", "box"]);
    expect(ready).toMatchObject({ severity: "warn", fix: { command: "t3-fleet repo rename", safe: false } });
  });

  it("only notes it while a machine runs another build or cannot be reached", () => {
    const behind = repoNames([{ node: "mac", observed: observed() }, { node: "box", observed: observed({ installed: "old" }) }], ["mac", "box"]);
    expect(behind).toMatchObject({ severity: "info" });
    expect(behind?.fix).toBeUndefined();
    const unreachable = repoNames([{ node: "mac", observed: observed() }], ["mac", "box"]);
    expect(unreachable?.fix).toBeUndefined();
  });

  it("says nothing once the repo is renamed", () => {
    expect(repoNames([{ node: "mac", observed: observed({ repoRenamed: true }) }], ["mac"])).toBeUndefined();
  });
});

describe("engine-timer on macOS", () => {
  const timerFix = (inJob: boolean) =>
    EngineArea.diagnose({
      node: "mac",
      desired: { timer: true },
      observed: observed({ platform: "darwin", nodePath: process.execPath, timer: { installed: "<old/>", want: "<plist/>", loaded: true, inJob } }),
      fleet: [],
      authority: null,
    }).find((f) => f.key === "engine-timer")?.fix?.command ?? "";

  /** Runs the fix the way a sync does (bash reading stdin, a child of the sync), with launchctl faked; returns its calls. */
  const run = (inJob: boolean) => {
    const home = mkdtempSync(join(tmpdir(), "t3f-timer-"));
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin/launchctl"), `#!/bin/sh\necho "$@" >> "${home}/calls"\n`, { mode: 0o755 });
    writeFileSync(join(home, "fix.sh"), timerFix(inJob));
    const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env["PATH"] ?? ""}` };
    // The parent stands in for the sync: it notes whether launchctl ran before it exits.
    const early = execFileSync("sh", ["-c", `bash -s < "$1" >/dev/null; cat "$HOME/calls" 2>/dev/null; sleep 1`, "_", join(home, "fix.sh")], { env, encoding: "utf8" });
    return { home, early, calls: () => (existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "") };
  };

  it("reloads the job at once when a person runs it", () => {
    const { home, early } = run(false);
    expect(early).toMatch(/bootout gui\/\d+\/dev\.t3-fleet\.sync\nbootstrap gui\/\d+ /);
    expect(readFileSync(join(home, "Library/LaunchAgents/dev.t3-fleet.sync.plist"), "utf8")).toBe("<plist/>\n");
  });

  it("inside the timer's own job, reloads it only after that sync has exited", async () => {
    const { early, calls } = run(true);
    expect(early).toBe("");
    for (let i = 0; i < 50 && !calls().includes("bootstrap"); i++) await Effect.runPromise(Effect.sleep("100 millis"));
    expect(calls()).toMatch(/bootout gui\/\d+\/dev\.t3-fleet\.sync\nbootstrap gui\/\d+ /);
  });
});

describe("engine-local-config", () => {
  const node = (name: string, ssh: string | null) => ({ name, ssh, roles: ["member" as const], profiles: [], tailnet: null, settings: { table: {}, provenance: new Map() } });
  // A machine that joined with --dir: its repo is not the fleet's [fleet] checkout.
  const config: Config = { repo: "/Users/u/src/fleet-config", self: "mac", checkout: "~/fleet", branch: "main", interval: 900, alertAfter: 3, nodes: [node("mac", null), node("box", "box")], settings: {} };

  it("has this machine observe the repo it loaded, others their [fleet] checkout", () => {
    expect(probeSettings(config, config.nodes[0]).checkout).toBe("/Users/u/src/fleet-config");
    expect(probeSettings(config, config.nodes[1]).checkout).toBe("~/fleet");
  });

  it("leaves rewriting the local config to a person", () => {
    const [finding] = EngineArea.diagnose({
      node: "mac",
      desired: undefined,
      observed: observed({ local: { want: 'repo = "~/fleet"\nnode = "mac"\n', matches: false }, repoRenamed: true }),
      fleet: [],
      authority: null,
    });
    expect(finding).toMatchObject({ key: "engine-local-config", fix: { safe: false } });
  });
});
