import type { Config, Node } from "@t3-fleet/core/Config";
import type { NodeState } from "@t3-fleet/core/State";
import { mergeLayers } from "@t3-fleet/core/Settings";
import { toUiStatus } from "@t3-fleet/core/UiServer";
import { describe, expect, it } from "vite-plus/test";

import { newestStates, reportedCheck } from "./hubUi.ts";

const node = (name: string): Node => ({
  name,
  ssh: name === "box" ? null : name,
  roles: name === "laptop" ? ["authority"] : ["member"],
  profiles: [],
  tailnet: null,
  settings: mergeLayers([]),
});

const config: Config = {
  repo: "/tmp/none",
  self: "box",
  checkout: "~/fleet",
  branch: "main",
  interval: 900,
  alertAfter: 3,
  nodes: [node("laptop"), node("desk"), node("box")],
  settings: { accept: [] },
};

const state = (over: Partial<NodeState> & Pick<NodeState, "node">): NodeState => ({
  at: 1_000,
  result: "ok",
  streak: 0,
  message: "synced",
  rev: "abc1234",
  observation: null,
  findings: [],
  applied: [],
  alerts: [],
  ...over,
});

const latest = { agents: { claude: null, codex: null }, t3: {} };

describe("the hub's check, made of reports", () => {
  it("shows each machine's published findings with their fixes, and an older machine's without, saying so", () => {
    const check = reportedCheck(
      config,
      [
        state({
          node: "laptop",
          format: 2,
          findings: [
            {
              node: "laptop",
              key: "claude-behind",
              severity: "warn",
              area: "agents",
              title: "claude is behind",
              fix: { command: "npm i -g @anthropic-ai/claude-code@2.1.1", safe: true },
            },
          ],
        }),
        // T3 Fleet before 0.10: no format, findings without fixes.
        state({
          node: "desk",
          findings: [
            {
              node: "desk",
              key: "codex-behind",
              severity: "warn",
              area: "agents",
              title: "codex is behind",
            },
          ],
        }),
      ],
      latest,
    );
    const status = toUiStatus(check, 2_000);
    const byId = new Map(status.findings.map((f) => [f.id, f]));
    expect(byId.get("laptop:claude-behind")?.fix?.command).toBe(
      "npm i -g @anthropic-ai/claude-code@2.1.1",
    );
    expect(byId.get("desk:codex-behind")?.fix).toBeUndefined();
    expect(byId.get("desk:codex-behind")?.detail).toContain("does not report its fixes");
  });

  it("says a machine that never reported is not reported, and shows when each one did", () => {
    const status = toUiStatus(
      reportedCheck(config, [state({ node: "laptop", at: 1_234, format: 2 })], latest),
      2_000,
    );
    const env = new Map(status.environments.map((e) => [e.name, e]));
    expect(env.get("box")?.reachable).toBe(false);
    expect(env.get("box")?.error).toMatch(/^not reported/);
    expect(env.get("laptop")?.sync?.at).toBe(1_234);
  });

  it("ignores a report from a machine no longer in the fleet", () => {
    const check = reportedCheck(
      config,
      [
        state({
          node: "gone",
          findings: [{ node: "gone", key: "x", severity: "error", area: "t3", title: "x" }],
        }),
      ],
      latest,
    );
    expect(check.report.findings).toEqual([]);
  });

  it("keeps each machine's newest report, from the relay or its state branch", () => {
    const states = newestStates(
      [state({ node: "laptop", at: 5 }), state({ node: "desk", at: 1 })],
      [
        state({ node: "laptop", at: 3 }),
        state({ node: "desk", at: 9 }),
        state({ node: "box", at: 2 }),
      ],
    );
    expect(Object.fromEntries(states.map((s) => [s.node, s.at]))).toEqual({
      laptop: 5,
      desk: 9,
      box: 2,
    });
  });
});
