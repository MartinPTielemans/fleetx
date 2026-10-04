import { describe, expect, it } from "vite-plus/test";

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
