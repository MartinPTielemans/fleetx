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
import { ENGINE_INSTALL, EngineArea, systemdTimerScheduled } from "./Engine.ts";

const observed = (over: Record<string, unknown> = {}) => ({
  wanted: "abc",
  installed: "abc",
  local: null,
  platform: "linux",
  root: false,
  nodePath: "/usr/bin/node",
  timer: { installed: null, want: null, loaded: false },
  ...over,
});

const outdated = (over: Record<string, unknown>) =>
  EngineArea.diagnose({
    node: "box",
    desired: undefined,
    observed: observed({ wanted: "new", installed: "old", ...over }),
    fleet: [],
    authority: null,
  }).find((f) => f.key === "engine-outdated" || f.key === "engine-newer-here");

const build = (version: string, builtAt: number, commit = "abc1234") => ({
  version,
  builtAt,
  commit,
});

describe("engine-outdated", () => {
  it("installs the controller's build, as a safe fix, when it is the newer one", () => {
    const f = outdated({ wantedBuild: build("0.6.2", 2), installedBuild: build("0.6.1", 1) });
    expect(f).toMatchObject({
      key: "engine-outdated",
      fix: { command: ENGINE_INSTALL, safe: true },
    });
    expect(f?.title).toContain("older build (0.6.1 built");
    expect(f?.fix?.disrupts).toBeUndefined();
  });

  it("treats a build from before identities as older", () => {
    expect(outdated({ wantedBuild: build("0.6.2", 2), installedBuild: null })).toMatchObject({
      key: "engine-outdated",
      fix: { safe: true },
    });
    expect(outdated({ installed: null, wantedBuild: build("0.6.2", 2) })).toMatchObject({
      title: "T3 Fleet is not installed here",
      fix: { safe: true },
    });
  });

  it("never offers to downgrade a node that runs a newer build than the controller", () => {
    const f = outdated({ wantedBuild: build("0.6.1", 9), installedBuild: build("0.6.2", 1) });
    expect(f).toMatchObject({ key: "engine-newer-here", severity: "warn" });
    expect(f?.fix).toBeUndefined();
    expect(f?.detail).toContain("upgrade T3 Fleet on the machine you run it from");
    // A rebuild of the same version is newer by its build time.
    expect(
      outdated({ wantedBuild: build("0.6.2", 1), installedBuild: build("0.6.2", 2) })?.key,
    ).toBe("engine-newer-here");
  });

  it("asks before installing when neither build is known to be newer", () => {
    expect(
      outdated({ wantedBuild: build("0.6.2", 1), installedBuild: build("0.6.2", 1) }),
    ).toMatchObject({ fix: { safe: false } });
  });

  it("asks before installing a build of the same version from another commit, however recent", () => {
    const f = outdated({
      wantedBuild: build("0.6.1", 9, "old0001"),
      installedBuild: build("0.6.1", 1, "new0002"),
    });
    expect(f).toMatchObject({
      key: "engine-outdated",
      fix: { command: ENGINE_INSTALL, safe: false },
    });
    expect(f?.title).toContain("neither is known to be newer");
    expect(f?.detail).toContain("same version built from different commits");
  });

  it("says which services the install restarts", () => {
    const f = outdated({
      wantedBuild: build("0.6.2", 2),
      installedBuild: build("0.6.1", 1),
      services: ["serve", "listen"],
    });
    expect(f?.fix?.disrupts).toBe("restarts the relay and the listener on box");
  });
});

describe("engine-timer on systemd", () => {
  // As `systemctl show t3-fleet-sync.timer -p ActiveState -p SubState -p NextElapseUSecMonotonic -p NextElapseUSecRealtime` prints them.
  const show = (sub: string, mono: string, real = "") =>
    `NextElapseUSecRealtime=${real}\nNextElapseUSecMonotonic=${mono}\nActiveState=active\nSubState=${sub}\n`;

  it("counts a timer waiting for its next run as scheduled", () => {
    expect(systemdTimerScheduled(show("waiting", "3month 4w 8h 9min 27.959738s"))).toBe(true);
  });

  it("counts a timer whose sync is running as scheduled, though it has no next run yet", () => {
    expect(systemdTimerScheduled(show("running", "infinity"))).toBe(true);
  });

  it("flags a timer that elapsed and will never run again", () => {
    expect(systemdTimerScheduled(show("elapsed", "infinity"))).toBe(false);
    expect(
      systemdTimerScheduled(
        "ActiveState=inactive\nSubState=dead\nNextElapseUSecMonotonic=infinity\n",
      ),
    ).toBe(false);
  });
});

describe("engine-timer on macOS", () => {
  const timerFix = (
    inJob: boolean,
    timer: Record<string, unknown> = { installed: "<old/>", want: "<plist/>", loaded: true },
    desired: { timer: boolean } = { timer: true },
  ) =>
    EngineArea.diagnose({
      node: "mac",
      desired,
      observed: observed({
        platform: "darwin",
        nodePath: process.execPath,
        timer: { ...timer, inJob },
      }),
      fleet: [],
      authority: null,
    }).find((f) => f.key.startsWith("engine-timer"))?.fix?.command ?? "";

  /** Runs a fix the way a sync does (bash reading stdin, a child of the sync), with launchctl faked; returns its calls. */
  const run = (fix: string, failBootstrap = false) => {
    const home = mkdtempSync(join(tmpdir(), "t3f-timer-"));
    mkdirSync(join(home, "bin"));
    // launchd knows no job once it is booted out: print fails.
    writeFileSync(
      join(home, "bin/launchctl"),
      `#!/bin/sh\necho "$@" >> "${home}/calls"\n[ "$1" = print ] && exit 113\n${failBootstrap ? '[ "$1" = bootstrap ] && exit 5\n' : ""}exit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(home, "fix.sh"), fix);
    const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env["PATH"] ?? ""}` };
    // The parent stands in for the sync: it notes whether launchctl ran before it exits.
    const early = execFileSync(
      "sh",
      [
        "-c",
        `bash -s < "$1" >/dev/null; cat "$HOME/calls" 2>/dev/null; sleep 1`,
        "_",
        join(home, "fix.sh"),
      ],
      { env, encoding: "utf8" },
    );
    const calls = () =>
      existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";
    const pending = () => existsSync(join(home, ".local/state/t3-fleet/sync-timer-reload.pending"));
    const settled = async (done: () => boolean) => {
      for (let i = 0; i < 50 && !done(); i++) await Effect.runPromise(Effect.sleep("100 millis"));
      // The helper's last steps, after its launchctl calls.
      await Effect.runPromise(Effect.sleep("200 millis"));
    };
    return { home, early, calls, pending, settled };
  };

  it("reloads the job at once when a person runs it", () => {
    const { home, early } = run(timerFix(false));
    expect(early).toMatch(
      /bootout gui\/\d+\/dev\.t3-fleet\.sync\nprint gui\/\d+\/dev\.t3-fleet\.sync\nbootstrap gui\/\d+ /,
    );
    expect(readFileSync(join(home, "Library/LaunchAgents/dev.t3-fleet.sync.plist"), "utf8")).toBe(
      "<plist/>\n",
    );
  });

  it("inside the timer's own job, reloads it only after that sync has exited", async () => {
    const { early, calls, pending, settled } = run(timerFix(true));
    expect(early).toBe("");
    await settled(() => calls().includes("bootstrap"));
    expect(calls()).toMatch(
      /bootout gui\/\d+\/dev\.t3-fleet\.sync\nprint gui\/\d+\/dev\.t3-fleet\.sync\nbootstrap gui\/\d+ /,
    );
    expect(pending()).toBe(false);
  });

  it("inside the job, removes the timer only after that sync has exited", async () => {
    const fix = timerFix(true, { installed: "<old/>", want: null, loaded: true }, { timer: false });
    expect(fix.match(/spawn\(/g)).toHaveLength(1);
    const { early, calls, settled } = run(fix);
    expect(early).toBe("");
    await settled(() => calls().includes("bootout"));
    expect(calls()).toMatch(/^bootout gui\/\d+\/dev\.t3-fleet\.sync\n$/);
  });

  it("leaves the pending marker when the deferred reload fails", async () => {
    const { calls, pending, settled } = run(timerFix(true), true);
    await settled(() => calls().includes("bootstrap"));
    expect(pending()).toBe(true);
  });

  it("reports a reload that never ran", () => {
    const stuck = { installed: "<plist/>", want: "<plist/>", loaded: true, reloadPending: true };
    const [finding] = EngineArea.diagnose({
      node: "mac",
      desired: { timer: true },
      observed: observed({ platform: "darwin", timer: stuck }),
      fleet: [],
      authority: null,
    });
    expect(finding).toMatchObject({
      key: "engine-timer",
      title: "the sync timer was changed, but launchd never reloaded it",
    });
    const removed = { installed: null, want: null, loaded: true, reloadPending: true };
    const [unwanted] = EngineArea.diagnose({
      node: "mac",
      desired: undefined,
      observed: observed({ platform: "darwin", timer: removed }),
      fleet: [],
      authority: null,
    });
    expect(unwanted).toMatchObject({
      key: "engine-timer-unwanted",
      title: "the sync timer was removed, but launchd still has it loaded",
    });
  });
});

describe("engine-local-config", () => {
  const node = (name: string, ssh: string | null) => ({
    name,
    ssh,
    roles: ["member" as const],
    profiles: [],
    tailnet: null,
    settings: { table: {}, provenance: new Map() },
  });
  // A machine that joined with --dir: its repo is not the fleet's [fleet] checkout.
  const config: Config = {
    repo: "/Users/u/src/fleet-config",
    self: "mac",
    checkout: "~/fleet",
    branch: "main",
    interval: 900,
    alertAfter: 3,
    nodes: [node("mac", null), node("box", "box")],
    settings: {},
  };

  it("has this machine observe the repo it loaded, others their [fleet] checkout", () => {
    expect(probeSettings(config, config.nodes[0]).checkout).toBe("/Users/u/src/fleet-config");
    expect(probeSettings(config, config.nodes[1]).checkout).toBe("~/fleet");
  });

  it("leaves rewriting the local config to a person", () => {
    const [finding] = EngineArea.diagnose({
      node: "mac",
      desired: undefined,
      observed: observed({
        local: { want: 'repo = "~/fleet"\nnode = "mac"\n', matches: false },
      }),
      fleet: [],
      authority: null,
    });
    expect(finding).toMatchObject({ key: "engine-local-config", fix: { safe: false } });
  });
});
