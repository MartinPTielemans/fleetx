import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";

import { mergeAdditions } from "./TomlMerge.ts";

const BASE = `# the fleet
[fleet]
auto_approve = ["skills/"]
interval = 900

[defaults.mcp]
servers = ["fetch"] # every machine

[[defaults.instructions]]
src = "instructions/claude/CLAUDE.md"
dest = "~/.claude/CLAUDE.md"
`;
const ENTRY = `
[[defaults.instructions]]
src = "instructions/codex/AGENTS.md"
dest = "~/.codex/AGENTS.md"
`;

describe("mergeAdditions", () => {
  it("merges two machines that each only add servers and instruction entries", () => {
    const ours = BASE.replace('["fetch"]', '["fetch", "notes"]');
    const theirs = `${BASE.replace('["fetch"]', '["fetch", "posthog"]')}${ENTRY}`;
    const merged = mergeAdditions(BASE, ours, theirs);
    expect(merged).toContain("# every machine");
    expect(parse(merged ?? "")).toMatchObject({
      defaults: {
        mcp: { servers: ["fetch", "notes", "posthog"] },
        instructions: [
          { src: "instructions/claude/CLAUDE.md", dest: "~/.claude/CLAUDE.md" },
          { src: "instructions/codex/AGENTS.md", dest: "~/.codex/AGENTS.md" },
        ],
      },
    });
    // The same addition on both sides is one.
    expect(parse(mergeAdditions(BASE, ours, ours) ?? "")).toMatchObject({
      defaults: { mcp: { servers: ["fetch", "notes"] } },
    });
  });

  it("merges the first instruction entries when the fleet has none yet, from any number of machines", () => {
    const base = BASE.replace(/\n\[\[defaults\.instructions\]\][^]*$/, "");
    const claude = `\n[[defaults.instructions]]\nsrc = "instructions/claude/CLAUDE.md"\ndest = "~/.claude/CLAUDE.md"\n`;
    const a = `${base.replace('["fetch"]', '["fetch", "notes"]')}${claude}`;
    const b = `${base.replace('["fetch"]', '["fetch", "weather"]')}${ENTRY}`;
    const ab = mergeAdditions(base, a, b);
    expect(parse(ab ?? "")).toMatchObject({
      defaults: {
        mcp: { servers: ["fetch", "notes", "weather"] },
        instructions: [{ dest: "~/.claude/CLAUDE.md" }, { dest: "~/.codex/AGENTS.md" }],
      },
    });
    // A third machine, approved after both: each addition lands once.
    const c = `${base.replace('["fetch"]', '["fetch", "notes", "maps"]')}${claude}`;
    const abc = parse(mergeAdditions(base, ab ?? "", c) ?? "") as {
      defaults: { mcp: { servers: Array<string> }; instructions: Array<{ dest: string }> };
    };
    expect(abc.defaults.mcp.servers).toEqual(["fetch", "notes", "weather", "maps"]);
    expect(abc.defaults.instructions.map((i) => i.dest)).toEqual([
      "~/.claude/CLAUDE.md",
      "~/.codex/AGENTS.md",
    ]);
    // Two different entries for one file are still a real conflict.
    const other = claude.replace("instructions/claude/CLAUDE.md", "instructions/claude/OTHER.md");
    expect(mergeAdditions(base, a, `${base}${other}`)).toBeNull();
  });

  it("refuses anything else: removals, changed values, new tables, reorders, conflicts", () => {
    const adds = BASE.replace('["fetch"]', '["fetch", "notes"]');
    const refused = {
      "a removed key": BASE.replace('auto_approve = ["skills/"]\n', ""),
      "a changed value": BASE.replace("interval = 900", "interval = 60"),
      "a removed table": BASE.replace(/\[\[defaults\.instructions\]\][^]*$/, ""),
      "a new key": BASE.replace("interval = 900", "interval = 900\nz = 3"),
      "a reordered list": BASE.replace('["fetch"]', '["notes", "fetch"]'),
      "a removed item": BASE.replace('["fetch"]', "[]"),
    };
    for (const [what, theirs] of Object.entries(refused)) {
      expect([what, mergeAdditions(BASE, adds, theirs)]).toEqual([what, null]);
      expect([what, mergeAdditions(BASE, theirs, adds)]).toEqual([what, null]);
    }
  });

  it("takes a whole new table one side adds, and refuses two different ones", () => {
    const relay = (port: number) => `${BASE}\n[relay]\nport = ${port}\n`;
    const adds = BASE.replace('["fetch"]', '["fetch", "notes"]');
    expect(parse(mergeAdditions(BASE, adds, relay(8399)) ?? "")).toMatchObject({
      relay: { port: 8399 },
      defaults: { mcp: { servers: ["fetch", "notes"] } },
    });
    expect(mergeAdditions(BASE, relay(8399), relay(8399))).not.toBeNull();
    expect(mergeAdditions(BASE, relay(8399), relay(1))).toBeNull();
    // A table the branch removed is not brought back by the other side's edit to it.
    const withModels = `${BASE}\n[models]\negress = "direct"\n`;
    expect(mergeAdditions(withModels, BASE, withModels.replace('"direct"', '"relay"'))).toBeNull();
  });

  it("refuses one server both used and left alone, and two entries for one file", () => {
    const node = '[mcp]\n"servers.add" = ["a"]\n"ignore.add" = ["b"]\n';
    expect(
      mergeAdditions(
        node,
        node.replace('["a"]', '["a", "x"]'),
        node.replace('"ignore.add" = ["b"]', '"ignore.add" = ["b", "x"]'),
      ),
    ).toBeNull();
    const other = ENTRY.replace("instructions/codex/AGENTS.md", "codex/AGENTS.md");
    expect(mergeAdditions(BASE, `${BASE}${ENTRY}`, `${BASE}${other}`)).toBeNull();
  });
});
