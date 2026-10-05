import type { UiPlanConflict, UiProbe, UiSetupPlan, UiSetupState } from "@t3-fleet/core/SetupApi";
import { describe, expect, it } from "vite-plus/test";

import {
  blocker,
  chosen,
  conflictNow,
  followStage,
  initialAnswers,
  keepChoices,
  keepCredentials,
  looksLikeRemote,
  nodeNameProblem,
  NO_PLAN,
  ntfyPatch,
  openConflicts,
  persistable,
  planAnswered,
  planAsked,
  planReady,
  planRequest,
  settingParts,
  stepIndex,
  stepStates,
  stepsFor,
  suggestHubName,
  typedValues,
  type Answers,
} from "./wizard";

const state: UiSetupState = {
  stage: "fresh",
  hostname: "laptop.local",
  suggestedName: "laptop",
  checks: [{ key: "node", severity: "ok", title: "Node 24.13.1", detail: null }],
  github: "octo",
  unfinished: null,
  hub: null,
};

const item = { state: "ok", label: "", remedy: null } as const;
const probe = (over: Partial<UiProbe> = {}): UiProbe => ({
  ssh: "server",
  reachable: true,
  error: null,
  hostname: "server.tailnet.ts.net",
  os: "Ubuntu 24.04",
  node: item,
  git: item,
  t3: item,
  tailscale: item,
  docker: item,
  service: item,
  relayUrl: "https://server.tailnet.ts.net",
  ready: true,
  ...over,
});

const answers = (over: Partial<Answers> = {}): Answers => ({
  ...initialAnswers(state),
  alwaysOn: false,
  ...over,
});

describe("steps", () => {
  it("asks about the hub only with an always-on machine", () => {
    expect(stepsFor({ alwaysOn: true })).toContain("hub");
    expect(stepsFor({ alwaysOn: false })).not.toContain("hub");
    expect(stepsFor({ alwaysOn: null })).not.toContain("hub");
  });

  it("starts from the suggested name, a GitHub repo when signed in, nothing else decided", () => {
    const a = initialAnswers(state);
    expect(a.node).toBe("laptop");
    expect(a.repo).toBe("github");
    expect(a.alwaysOn).toBeNull();
    expect(initialAnswers({ ...state, github: null }).repo).toBeNull();
  });
});

describe("blocker", () => {
  const ctx = { state, probe: null };

  it("stops the first step on a pre-flight error, a bad name, or no answer", () => {
    const failing = {
      ...state,
      checks: [{ key: "node", severity: "error" as const, title: "Node 20", detail: "needs 24" }],
    };
    expect(blocker("machines", answers(), { state: failing, probe: null })).toMatch(/Fix/);
    expect(blocker("machines", answers({ node: "my laptop" }), ctx)).toMatch(/name/);
    expect(blocker("machines", answers({ alwaysOn: null }), ctx)).toMatch(/always-on/);
    expect(blocker("machines", answers(), ctx)).toBeNull();
  });

  it("needs a repository that can be made or reached", () => {
    expect(blocker("repo", answers({ repo: null }), ctx)).not.toBeNull();
    expect(blocker("repo", answers({ repo: "github", githubName: "" }), ctx)).not.toBeNull();
    expect(blocker("repo", answers({ repo: "github" }), ctx)).toBeNull();
    expect(
      blocker("repo", answers({ repo: "github" }), {
        state: { ...state, github: null },
        probe: null,
      }),
    ).toMatch(/gh/);
    expect(blocker("repo", answers({ repo: "url", url: "fleet" }), ctx)).not.toBeNull();
    expect(
      blocker("repo", answers({ repo: "url", url: "git@github.com:o/fleet.git" }), ctx),
    ).toBeNull();
    expect(blocker("repo", answers({ repo: "local" }), ctx)).toBeNull();
  });

  it("needs a checked, ready, named hub, or skipping it", () => {
    const hub = answers({ alwaysOn: true, hubSsh: "server", hubNode: "server" });
    expect(blocker("hub", hub, ctx)).toMatch(/Check/);
    expect(blocker("hub", hub, { state, probe: probe({ ssh: "other" }) })).toMatch(/Check/);
    expect(
      blocker("hub", hub, { state, probe: probe({ reachable: false, ready: false }) }),
    ).toMatch(/reached/);
    expect(blocker("hub", hub, { state, probe: probe({ ready: false }) })).toMatch(/missing/);
    expect(blocker("hub", { ...hub, hubNode: "laptop" }, { state, probe: probe() })).toMatch(/own/);
    expect(blocker("hub", hub, { state, probe: probe() })).toBeNull();
    expect(blocker("hub", { ...hub, hubSkipped: true }, ctx)).toBeNull();
  });
});

describe("requests", () => {
  it("sends the hub only when there is one and it was not skipped", () => {
    const hub = answers({ alwaysOn: true, hubSsh: " me@server ", hubNode: "server" });
    expect(planRequest(hub).hub).toEqual({ ssh: "me@server", node: "server", mcp: false });
    expect(planRequest({ ...hub, hubMcp: true }).hub).toEqual({
      ssh: "me@server",
      node: "server",
      mcp: true,
    });
    expect(planRequest({ ...hub, hubSkipped: true }).hub).toBeNull();
    expect(planRequest({ ...hub, alwaysOn: false }).hub).toBeNull();
  });

  it("makes each kind of repository", () => {
    expect(planRequest(answers({ repo: "github", githubName: "fleet" })).repo).toEqual({
      kind: "github",
      name: "fleet",
    });
    expect(planRequest(answers({ repo: "url", url: " https://x.dev/a/b " })).repo).toEqual({
      kind: "url",
      url: "https://x.dev/a/b",
    });
    expect(planRequest(answers({ repo: "local" })).repo).toEqual({ kind: "local" });
  });

  it("asks for updates and a notification here by default, nothing pushed, no MCP hosting", () => {
    const a = initialAnswers(state);
    expect(planRequest(a)).toMatchObject({
      autoUpdate: true,
      notify: { desktop: true, ntfy: null },
    });
    expect(a.hubMcp).toBe(false);
    expect(planRequest({ ...a, autoUpdate: false, notifyDesktop: false }).autoUpdate).toBe(false);
  });

  it("makes an ntfy topic when turned on, forgets it when off, and never keeps it across a reload", () => {
    const on = { ...answers(), ...ntfyPatch(answers(), true) };
    expect(on.ntfyUrl).toMatch(/^https:\/\/ntfy\.sh\/[a-z0-9]{24,}$/);
    expect(planRequest(on).notify.ntfy).toBe(on.ntfyUrl);
    expect({ ...on, ...ntfyPatch(on, true) }.ntfyUrl).toBe(on.ntfyUrl);
    const off = { ...on, ...ntfyPatch(on, false) };
    expect(off.ntfyUrl).toBe("");
    expect(planRequest(off).notify.ntfy).toBeNull();
    expect({ ...off, ...ntfyPatch(off, true) }.ntfyUrl).not.toBe(on.ntfyUrl);
    const kept = persistable(on);
    expect(JSON.stringify(kept)).not.toContain(on.ntfyUrl);
    expect(kept).toMatchObject({ ntfy: false, ntfyUrl: "", node: on.node });
  });

  it("sends only credentials the plan asks for, leaving out those set later or left blank", () => {
    const plan = { missing: ["A", "B", "C"].map((name) => ({ name, why: "" })) };
    expect(typedValues({ A: "1", B: "", C: "3", OLD: "4" }, new Set(["C"]), plan)).toEqual({
      A: "1",
    });
  });

  it("forgets what was typed for credentials a new plan no longer asks for", () => {
    const plan = { missing: [{ name: "A", why: "" }] };
    const kept = keepCredentials({ A: "1", B: "2" }, new Set(["A", "B"]), plan);
    expect(kept.values).toEqual({ A: "1" });
    expect([...kept.later]).toEqual(["A"]);
  });
});

describe("settings", () => {
  it("splits a plan's setting into its sentence and where it goes", () => {
    expect(settingParts("Notify you on laptop for every fleet alert ([notify] desktop)")).toEqual({
      text: "Notify you on laptop for every fleet alert",
      where: "[notify] desktop",
    });
    expect(
      settingParts(
        "Push alerts with ntfy ([notify] ntfy; the topic URL is the secret T3_FLEET_NTFY_URL)",
      ),
    ).toEqual({ text: "Push alerts with ntfy", where: "[notify] ntfy" });
    expect(settingParts("Plain words")).toEqual({ text: "Plain words", where: null });
  });
});

describe("names", () => {
  it("checks node names and suggests one for the hub", () => {
    expect(nodeNameProblem("")).not.toBeNull();
    expect(nodeNameProblem("-x")).not.toBeNull();
    expect(nodeNameProblem("Mac")).not.toBeNull();
    expect(nodeNameProblem("mac-mini-2")).toBeNull();
    expect(suggestHubName("Box.tailnet.ts.net", "me@box")).toBe("box");
    expect(suggestHubName("Mac_Mini.local", "mini")).toBe("mac-mini");
    expect(suggestHubName(null, "me@10.0.0.4")).toBe("10");
    expect(suggestHubName(null, "")).toBe("hub");
  });

  it("knows a remote when it sees one", () => {
    expect(looksLikeRemote("https://github.com/o/fleet")).toBe(true);
    expect(looksLikeRemote("git@github.com:o/fleet.git")).toBe(true);
    expect(looksLikeRemote("ssh://git@host/o/fleet")).toBe(true);
    expect(looksLikeRemote("fleet")).toBe(false);
  });
});

describe("conflicts", () => {
  const first: UiPlanConflict = {
    id: "skill-here:tdd",
    kind: "skill",
    name: "tdd",
    title: "skill tdd: 2 different copies on this machine",
    detail: "newest: ~/.claude/skills/tdd\nolder: ~/.codex/skills/tdd",
    choices: [
      { value: "copy:0", label: "use the newest" },
      { value: "copy:1", label: "use the older" },
    ],
    default: "copy:0",
    after: null,
  };
  const follows: UiPlanConflict = {
    id: "skill:tdd",
    kind: "skill",
    name: "tdd",
    title: "skill tdd is not the fleet's",
    detail: "-a\n+b",
    choices: [
      { value: "fleet", label: "keep the fleet's" },
      { value: "mine", label: "use this one" },
    ],
    default: "fleet",
    after: "skill-here:tdd",
    byChoice: { "copy:0": "-a\n+newest", "copy:1": null },
  };
  const plan = { conflicts: [first, follows] } as unknown as UiSetupPlan;

  it("follows the earlier choice: its diff, or settled", () => {
    expect(conflictNow(follows, {}, plan.conflicts)).toEqual({
      applies: true,
      detail: "-a\n+newest",
    });
    expect(conflictNow(follows, { [first.id]: "copy:1" }, plan.conflicts).applies).toBe(false);
    expect(openConflicts(plan, { [first.id]: "copy:1" }).map((c) => c.id)).toEqual([first.id]);
  });

  it("asks a follow-up without per-choice diffs every time, with its own", () => {
    const { byChoice: _, ...plain } = follows;
    expect(conflictNow(plain, { [first.id]: "copy:1" }, plan.conflicts)).toEqual({
      applies: true,
      detail: "-a\n+b",
    });
  });

  it("keeps choices across a new plan where the conflict and the choice are still there", () => {
    const again = { conflicts: [first] } as unknown as UiSetupPlan;
    expect(keepChoices({ [first.id]: "copy:1", [follows.id]: "mine", gone: "x" }, again)).toEqual({
      [first.id]: "copy:1",
    });
    expect(keepChoices({ [first.id]: "copy:9" }, plan)).toEqual({});
  });

  it("sends every open conflict's choice, defaults included, and not settled ones", () => {
    expect(chosen(plan, {})).toEqual({ [first.id]: "copy:0", [follows.id]: "fleet" });
    expect(chosen(plan, { [first.id]: "copy:1", [follows.id]: "mine" })).toEqual({
      [first.id]: "copy:1",
    });
  });
});

describe("progress", () => {
  const steps = ["Snapshot the clients' MCP servers", "Create the repo", "Commit and push"];

  it("matches a job's step to the plan's, loosely", () => {
    expect(stepIndex(steps, "create the repo…")).toBe(1);
    expect(stepIndex(steps, "Commit and push: 3 files")).toBe(2);
    expect(stepIndex(steps, "starting")).toBe(-1);
    expect(stepIndex(steps, null)).toBe(-1);
  });

  it("ticks off steps up to the one reached", () => {
    expect(stepStates(3, null, -1)).toEqual(["waiting", "waiting", "waiting"]);
    expect(stepStates(3, { state: "running" }, -1)).toEqual(["running", "waiting", "waiting"]);
    expect(stepStates(3, { state: "running" }, 1)).toEqual(["done", "running", "waiting"]);
    expect(stepStates(3, { state: "failed" }, 2)).toEqual(["done", "done", "failed"]);
    expect(stepStates(3, { state: "done" }, 0)).toEqual(["done", "done", "done"]);
  });
});

describe("making the plan", () => {
  const a = { planId: "a" } as UiSetupPlan;
  const b = { planId: "b" } as UiSetupPlan;

  it("applies only the plan for the answers as they are now, made without an error", () => {
    const made = planAnswered(planAsked(NO_PLAN, "k1", 1), 1, { data: a });
    expect(planReady(made, "k1")).toBe(true);
    // The answers changed since: not this plan.
    expect(planReady(made, "k2")).toBe(false);
    // Asked again: the old plan stays on screen, but cannot be applied until the answer comes.
    const asking = planAsked(made, "k2", 2);
    expect(asking.data).toBe(a);
    expect(planReady(asking, "k2")).toBe(false);
  });

  it("leaves no plan to apply when making it again fails", () => {
    const made = planAnswered(planAsked(NO_PLAN, "k1", 1), 1, { data: a });
    const failed = planAnswered(planAsked(made, "k2", 2), 2, { error: new Error("no") });
    expect(failed).toMatchObject({ data: null, key: "k2", loading: false });
    expect(planReady(failed, "k2")).toBe(false);
    expect(planReady(failed, "k1")).toBe(false);
    // The same answers asked again and failing: the old plan goes too.
    const again = planAnswered(planAsked(made, "k1", 2), 2, { error: new Error("no") });
    expect(again.data).toBeNull();
  });

  it("drops an answer to an older ask, whichever comes last", () => {
    const first = planAsked(NO_PLAN, "k1", 1);
    const second = planAsked(first, "k2", 2);
    const newer = planAnswered(second, 2, { data: b });
    expect(planAnswered(newer, 1, { data: a })).toBe(newer);
    expect(planAnswered(newer, 1, { error: new Error("late") })).toBe(newer);
    expect(planReady(newer, "k2")).toBe(true);
  });
});

describe("following the state", () => {
  it("moves a wizard not following a run into the fleet, or to the run; leaves one following alone", () => {
    const fresh = { stage: "fresh" as const, hub: null };
    const hub = { node: "box", ssh: "me@box", error: null };
    expect(followStage(fresh, "plan")).toBeNull();
    expect(followStage({ stage: "member", hub: null }, "plan")).toBe("member");
    expect(followStage({ stage: "unfinished", hub: null }, "machines")).toBe("apply");
    expect(followStage({ stage: "member", hub }, "repo")).toBe("apply");
    expect(followStage({ stage: "fresh", hub }, "repo")).toBe("apply");
    expect(followStage({ stage: "member", hub: null }, "apply")).toBeNull();
    expect(followStage({ stage: "unfinished", hub: null }, "done")).toBeNull();
  });
});
