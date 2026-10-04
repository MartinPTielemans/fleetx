import { describe, expect, it } from "vite-plus/test";

import { fromClaude, fromCodex, secretNamer } from "./Credentials.ts";
import type { Discovery, FoundServer, SkillCopy } from "./Discover.ts";
import { applies, buildPlan, decide, EMPTY_FLEET, lineDiff, type FleetView } from "./Plan.ts";

const HOME = "/home/u";
const paths = { home: HOME, checkout: `${HOME}/fleet` };
const name = secretNamer([]);
const ctx = { home: HOME, env: {}, name };

const skill = (n: string, root: string, hash: string, modified = 0): SkillCopy => ({
  name: n,
  root,
  entry: `${root.replace("~", HOME)}/${n}`,
  dir: `${root.replace("~", HOME)}/${n}`,
  hash,
  modified,
  source: null,
  text: `---\nname: ${n}\n---\n${hash}\n`,
  files: null,
});
const server = (
  n: string,
  client: "claude" | "codex",
  entry: Record<string, unknown>,
  project: string | null = null,
): FoundServer => ({
  name: n,
  client,
  project,
  entry,
  extracted: (client === "claude" ? fromClaude(n, entry, ctx) : fromCodex(n, entry, ctx))!,
});
const discovery = (over: Partial<Discovery>): Discovery => ({
  node: "laptop",
  skills: [],
  plugins: [],
  servers: [],
  instructions: [],
  t3: { running: false, version: null, channel: null, providers: [] },
  agents: [],
  raw: { claude: null, codex: null },
  unreadable: [],
  ...over,
});

describe("buildPlan on the first machine", () => {
  const found = discovery({
    skills: [
      skill("review", "~/.agents/skills", "a", 1),
      skill("review", "~/.claude/skills", "b", 2),
      skill("lint", "~/.claude/skills", "c"),
      skill("lint", "~/.codex/skills", "c"),
    ],
    plugins: [{ name: "plug", at: "~/.claude/skills/plug" }],
    servers: [
      server("ctx", "claude", {
        command: "npx",
        args: ["ctx", "--api-key", "k9Zr2mV7xK1pL4nB9cT3wY6s"],
      }),
      server("ctx", "codex", { command: "npx", args: ["ctx"] }),
      server("local", "claude", { type: "http", url: "http://127.0.0.1:9000/mcp" }),
      server("db", "claude", { command: "db", args: ["postgres://a:pw@h/db"] }, "~/code/app"),
      server("local", "claude", { command: "x" }, "~/code/other"),
    ],
  });
  const plan = buildPlan({
    mode: "first",
    node: "laptop",
    authority: true,
    found,
    fleet: EMPTY_FLEET,
  });

  it("asks which copy to use when one machine has two, newest first", () => {
    const review = plan.conflicts.find((c) => c.id === "skill-here:review");
    expect(review?.default).toBe("copy:0");
    expect(review?.detail).toMatch(/^newest: ~\/\.claude\/skills\/review/);
    expect(plan.add.skills.map((s) => s.name)).toEqual(["lint"]);
  });

  it("takes one server per name, and asks when the clients disagree", () => {
    expect(plan.conflicts.find((c) => c.id === "server-here:ctx")).toBeDefined();
    expect(plan.add.servers.map((s) => [s.name, s.scope])).toEqual([
      ["local", "machine"],
      ["db", "declared"],
      ["local-other", "declared"],
    ]);
  });

  it("leaves plugin skills to Claude, and lists every secret", () => {
    expect(plan.leftAlone.map((l) => l.what)).toContain("skill plug (~/.claude/skills/plug)");
    expect(plan.secrets.map((s) => s.name).sort()).toEqual(["CTX_API_KEY", "DB_PASSWORD"]);
  });

  it("decides: copies moved aside and linked, defaults taken", () => {
    const actions = decide(plan, {}, paths);
    expect(actions.skills.map((s) => [s.name, s.from])).toEqual([
      ["lint", `${HOME}/.claude/skills/lint`],
      ["review", `${HOME}/.claude/skills/review`],
    ]);
    expect(actions.links).toContainEqual({
      path: `${HOME}/.agents/skills/review`,
      link: `${HOME}/fleet/skills/review`,
    });
    expect(actions.links).toContainEqual({
      path: `${HOME}/.claude/skills/lint`,
      link: `${HOME}/.agents/skills/lint`,
    });
    // Codex reads ~/.agents/skills: its own copy is only moved aside, never doubled.
    expect(actions.links).toContainEqual({ path: `${HOME}/.codex/skills/lint`, link: null });
    expect(actions.servers.find((s) => s.name === "ctx")?.definition["args"]).toEqual([
      "ctx",
      "--api-key",
      "$CTX_API_KEY",
    ]);
  });
});

describe("buildPlan on a machine set up already", () => {
  const fleet: FleetView = {
    ...EMPTY_FLEET,
    servers: new Map([["web", { kind: "direct", url: "https://web.example.com/mcp" }]]),
  };
  const found = discovery({
    servers: [
      server("web", "claude", { type: "http", url: "https://web.example.com/mcp" }),
      server("repo", "codex", { command: "repo-mcp", tool_timeout_sec: 600 }),
      server("both", "claude", { command: "both-mcp" }),
      server("both", "codex", { command: "both-mcp", args: ["--codex"] }),
    ],
  });
  const plan = buildPlan({ mode: "again", node: "laptop", authority: true, found, fleet });

  it("leaves a server the fleet does not declare alone unless asked to add it", () => {
    expect(plan.add.servers).toEqual([]);
    expect(plan.conflicts.map((c) => [c.id, c.default, c.after])).toEqual([
      ["new-server:repo", "here", undefined],
      ["server-here:both", "copy:0", undefined],
      ["new-server:both", "here", "server-here:both"],
    ]);
    expect(plan.leftAlone).toContainEqual({
      what: "repo: tool_timeout_sec",
      why: "a definition cannot carry these client settings",
    });
    const kept = decide(plan, {}, paths);
    expect(kept.servers).toEqual([]);
    expect(kept.ignored.map((i) => i.name)).toEqual(["repo", "both"]);
    const added = decide(
      plan,
      { "new-server:repo": "mine", "server-here:both": "copy:1", "new-server:both": "mine" },
      paths,
    );
    expect(added.servers.map((s) => [s.name, s.definition["args"]])).toEqual([
      ["repo", []],
      ["both", ["--codex"]],
    ]);
    expect(added.ignored).toEqual([]);
  });
});

describe("buildPlan on a joining machine", () => {
  const fleet: FleetView = {
    ...EMPTY_FLEET,
    skills: new Map([
      ["review", "fleet-hash"],
      ["same", "s"],
    ]),
    servers: new Map([
      ["ctx", { kind: "stdio", command: "npx", args: ["ctx", "--api-key", "$FLEET_NAME"] }],
      ["web", { kind: "direct", url: "https://web.example.com/mcp" }],
    ]),
    instructions: [{ src: "claude/CLAUDE.md", dest: "~/.claude/CLAUDE.md", text: "fleet\n" }],
  };
  const found = discovery({
    node: "desktop",
    skills: [skill("review", "~/.claude/skills", "mine"), skill("same", "~/.agents/skills", "s")],
    servers: [
      server("ctx", "claude", {
        command: "npx",
        args: ["ctx", "--api-key", "zz9Zr2mV7xK1pL4nB9cT3wY"],
      }),
      server("web", "claude", { type: "http", url: "https://web.example.com/v2" }),
    ],
    instructions: [
      {
        dest: "~/.claude/CLAUDE.md",
        src: "instructions/claude/CLAUDE.md",
        at: `${HOME}/.claude/CLAUDE.md`,
        text: "mine\n",
      },
    ],
  });
  const plan = buildPlan({ mode: "join", node: "desktop", authority: false, found, fleet });

  it("treats definitions that differ only in secret names as the same server", () => {
    expect(plan.same.servers.map((s) => s.name)).toEqual(["ctx"]);
    expect(plan.same.skills.map((s) => s.name)).toEqual(["same"]);
  });

  it("offers the owner's choices, keeping mine and proposing it by default", () => {
    expect(plan.conflicts.map((c) => [c.id, c.default])).toEqual([
      ["skill:review", "mine"],
      ["server:web", "mine"],
      ["instruction:~/.claude/CLAUDE.md", "mine"],
    ]);
    expect(plan.conflicts[0]?.choices.map((c) => c.value)).toEqual(["mine", "fleet", "both"]);
    expect(plan.conflicts[2]?.detail).toContain("- fleet\n+ mine");
  });

  it("decides each choice", () => {
    const actions = decide(
      plan,
      { "skill:review": "both", "server:web": "here", "instruction:~/.claude/CLAUDE.md": "fleet" },
      paths,
    );
    expect(actions.skills.map((s) => s.name)).toEqual(["review@desktop"]);
    expect(actions.links).toContainEqual({
      path: `${HOME}/.agents/skills/review`,
      link: `${HOME}/fleet/skills/review`,
    });
    expect(actions.serversHereOnly).toEqual(["web"]);
    expect(actions.links).toContainEqual({
      path: `${HOME}/.claude/CLAUDE.md`,
      link: `${HOME}/fleet/claude/CLAUDE.md`,
    });
    expect(actions.secrets).toEqual([]);
  });
});

describe("choices on this machine, then the fleet's", () => {
  const fleet: FleetView = {
    ...EMPTY_FLEET,
    skills: new Map([["review", "b"]]),
    servers: new Map([["ctx", { kind: "stdio", command: "npx", args: ["ctx", "--fleet"] }]]),
  };
  const found = discovery({
    node: "desktop",
    skills: [
      skill("review", "~/.agents/skills", "a", 2),
      skill("review", "~/.claude/skills", "b", 1),
    ],
    servers: [
      server("ctx", "claude", { command: "npx", args: ["ctx", "--claude"] }),
      server("ctx", "codex", { command: "npx", args: ["ctx", "--fleet"] }),
    ],
  });
  const plan = buildPlan({ mode: "join", node: "desktop", authority: false, found, fleet });

  it("compares the copy chosen here with the fleet's, and offers the fleet's", () => {
    const review = plan.conflicts.find((c) => c.id === "skill:review");
    expect(review?.after).toBe("skill-here:review");
    expect(review?.choices.map((c) => c.value)).toEqual(["mine", "fleet", "both"]);
    // The newest copy differs from the fleet's: a question. The older one is the fleet's: none.
    expect(applies(review!, {}, plan.conflicts)).toBe(true);
    expect(applies(review!, { "skill-here:review": "copy:1" }, plan.conflicts)).toBe(false);
    expect(decide(plan, { "skill:review": "fleet" }, paths).skills).toEqual([]);
    expect(decide(plan, {}, paths).skills.map((s) => s.from)).toEqual([
      `${HOME}/.agents/skills/review`,
    ]);
  });

  it("does the same for Claude and Codex disagreeing", () => {
    expect(plan.conflicts.find((c) => c.id === "server:ctx")?.after).toBe("server-here:ctx");
    expect(decide(plan, { "server:ctx": "fleet" }, paths).servers).toEqual([]);
    // Codex's is the fleet's already: nothing to write, nothing to ask.
    expect(
      decide(plan, { "server-here:ctx": "copy:1", "server:ctx": "mine" }, paths).servers,
    ).toEqual([]);
  });
});

describe("servers setup does not take into the fleet", () => {
  const found = discovery({
    servers: [
      server("node_repl", "codex", {
        command: "/Applications/ChatGPT.app/Contents/Resources/node_repl",
      }),
      server("off", "codex", { command: "x", enabled: false }),
      server("linear", "codex", {
        url: "https://l.example/mcp",
        bearer_token_env_var: "LINEAR_KEY",
      }),
    ],
  });
  const plan = buildPlan({
    mode: "first",
    node: "laptop",
    authority: true,
    found,
    fleet: EMPTY_FLEET,
  });

  it("leaves an app's and a disabled server alone, through [mcp] ignore", () => {
    expect(plan.ignored.map((i) => i.name)).toEqual(["node_repl", "off"]);
    expect(decide(plan, {}, paths).ignored.map((i) => i.name)).toEqual([
      "node_repl",
      "off",
      "linear",
    ]);
  });

  it("keeps a server whose value is missing on this machine until it has one", () => {
    expect(plan.missing.map((m) => m.name)).toEqual(["LINEAR_KEY"]);
    const entered = [{ name: "LINEAR_KEY", value: "lin_entered_value_123", where: "entered" }];
    const actions = decide(plan, {}, paths, entered);
    expect(actions.servers.map((s) => s.name)).toEqual(["linear"]);
    expect(actions.secrets).toEqual(entered);
  });
});

describe("lineDiff", () => {
  it("marks removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc", "old", "new")).toBe(
      "--- old\n+++ new\n  a\n- b\n+ x\n  c",
    );
  });
});
