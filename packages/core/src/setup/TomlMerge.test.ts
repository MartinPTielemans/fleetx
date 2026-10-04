import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";

import { mergeAdditions } from "./TomlMerge.ts";

const BASE = `# the fleet
[defaults.mcp]
servers = ["fetch"] # every machine

[[defaults.instructions]]
src = "instructions/claude/CLAUDE.md"
dest = "~/.claude/CLAUDE.md"
`;

describe("mergeAdditions", () => {
  it("takes both machines' additions: list items, list-of-table entries, new tables", () => {
    const ours = BASE.replace('["fetch"]', '["fetch", "notes"]');
    const theirs = `${BASE.replace('["fetch"]', '["fetch", "posthog"]')}
[[defaults.instructions]]
src = "instructions/codex/AGENTS.md"
dest = "~/.codex/AGENTS.md"

[relay]
port = 8399
`;
    const merged = mergeAdditions(BASE, ours, theirs);
    expect(merged).not.toBeNull();
    expect(merged).toContain("# every machine");
    expect(parse(merged as string)).toEqual({
      defaults: {
        mcp: { servers: ["fetch", "notes", "posthog"] },
        instructions: [
          { src: "instructions/claude/CLAUDE.md", dest: "~/.claude/CLAUDE.md" },
          { src: "instructions/codex/AGENTS.md", dest: "~/.codex/AGENTS.md" },
        ],
      },
      relay: { port: 8399 },
    });
  });

  it("refuses what both changed differently, or what theirs removed", () => {
    const relay = `${BASE}\n[relay]\nport = 1\n`;
    expect(
      mergeAdditions(
        relay,
        relay.replace("port = 1", "port = 2"),
        relay.replace("port = 1", "port = 3"),
      ),
    ).toBeNull();
    expect(
      mergeAdditions(
        BASE,
        BASE.replace('["fetch"]', '["fetch", "a"]'),
        BASE.replace('["fetch"]', "[]"),
      ),
    ).toBeNull();
  });
});
