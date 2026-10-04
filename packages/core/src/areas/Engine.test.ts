import { describe, expect, it } from "vite-plus/test";

import { ENGINE_INSTALL, EngineArea } from "./Engine.ts";

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

const outdated = (over: Record<string, unknown>) =>
  EngineArea.diagnose({
    node: "box",
    desired: undefined,
    observed: observed({ wanted: "new", installed: "old", repoRenamed: true, ...over }),
    fleet: [],
    authority: null,
  }).find((f) => f.key === "engine-outdated" || f.key === "engine-newer-here");

const build = (version: string, builtAt: number) => ({ version, builtAt, commit: "abc1234" });

describe("engine-outdated", () => {
  it("installs the controller's build, as a safe fix, when it is the newer one", () => {
    const f = outdated({ wantedBuild: build("0.6.2", 2), installedBuild: build("0.6.1", 1) });
    expect(f).toMatchObject({ key: "engine-outdated", fix: { command: ENGINE_INSTALL, safe: true } });
    expect(f?.title).toContain("older build (0.6.1 built");
    expect(f?.fix?.disrupts).toBeUndefined();
  });

  it("treats a build from before identities as older", () => {
    expect(outdated({ wantedBuild: build("0.6.2", 2), installedBuild: null })).toMatchObject({ key: "engine-outdated", fix: { safe: true } });
    expect(outdated({ installed: null, wantedBuild: build("0.6.2", 2) })).toMatchObject({ title: "T3 Fleet is not installed here", fix: { safe: true } });
  });

  it("never offers to downgrade a node that runs a newer build than the controller", () => {
    const f = outdated({ wantedBuild: build("0.6.1", 9), installedBuild: build("0.6.2", 1) });
    expect(f).toMatchObject({ key: "engine-newer-here", severity: "warn" });
    expect(f?.fix).toBeUndefined();
    expect(f?.detail).toContain("upgrade T3 Fleet on the machine you run it from");
    // A rebuild of the same version is newer by its build time.
    expect(outdated({ wantedBuild: build("0.6.2", 1), installedBuild: build("0.6.2", 2) })?.key).toBe("engine-newer-here");
  });

  it("asks before installing when neither build is known to be newer", () => {
    expect(outdated({ wantedBuild: build("0.6.2", 1), installedBuild: build("0.6.2", 1) })).toMatchObject({ fix: { safe: false } });
  });

  it("says which services the install restarts", () => {
    const f = outdated({ wantedBuild: build("0.6.2", 2), installedBuild: build("0.6.1", 1), services: ["serve", "listen", "models"] });
    expect(f?.fix?.disrupts).toBe("restarts the relay, the listener and the model proxy on box");
  });
});
