import { describe, expect, it } from "vite-plus/test";

import { fromClaude, fromCodex, secretNamer } from "./Credentials.ts";
import type { Discovery, FoundServer, SkillCopy } from "./Discover.ts";
import { buildPlan, decide, EMPTY_FLEET, lineDiff, type FleetView } from "./Plan.ts";

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
    expect(plan.blocked).toEqual([]);
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
    autoCommit: ["skills"],
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

  it("is blocked when sync would not propose what it writes", () => {
    expect(plan.blocked[0]).toContain("mcp, t3-fleet.toml");
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

describe("lineDiff", () => {
  it("marks removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc", "old", "new")).toBe(
      "--- old\n+++ new\n  a\n- b\n+ x\n  c",
    );
  });
});
