import { parse } from "smol-toml";
import { describe, expect, it } from "vite-plus/test";

import { addToList, appendEntry, edits, setKey, type Edit } from "./TomlEdit.ts";

const text = (edit: Edit) => {
  if ("error" in edit) throw new Error(edit.error);
  return edit.text;
};

const FLEET = `# A comment people wrote.
[fleet]
branch = "main"

[defaults.mcp]
servers = ["fetch"] # inline comment

[defaults.skills]
store = "~/.agents/skills"
`;

describe("TomlEdit", () => {
  it("adds to a list in place, keeping comments and skipping values it has", () => {
    const out = text(addToList(FLEET, ["defaults", "mcp"], "servers", ["fetch", "posthog"]));
    expect(out).toContain("# A comment people wrote.");
    expect(parse(out)).toMatchObject({ defaults: { mcp: { servers: ["fetch", "posthog"] } } });
    expect(addToList(FLEET, ["defaults", "mcp"], "servers", ["fetch"])).toEqual({ text: FLEET });
  });

  it("adds a key to an existing table, or a new table at the end", () => {
    const out = text(
      edits(
        FLEET,
        (t) => setKey(t, ["defaults", "skills"], "clients", ["~/.claude/skills"]),
        (t) => setKey(t, ["mcp"], "servers.add", ["db"], "this machine's only"),
        (t) => setKey(t, [], "roles", ["authority", "relay"]),
      ),
    );
    expect(parse(out)).toMatchObject({
      roles: ["authority", "relay"],
      defaults: { skills: { store: "~/.agents/skills", clients: ["~/.claude/skills"] } },
      mcp: { "servers.add": ["db"] },
    });
    expect(out).toContain('"servers.add" = ["db"]');
    expect(out.indexOf("roles")).toBeLessThan(out.indexOf("[fleet]"));
  });

  it("replaces a top-level key", () => {
    const out = text(setKey('roles = ["member"]\n\n[mcp]\nservers = []\n', [], "roles", ["relay"]));
    expect(parse(out)).toEqual({ roles: ["relay"], mcp: { servers: [] } });
  });

  it("appends array-of-tables entries", () => {
    const out = text(
      appendEntry(FLEET, ["defaults", "instructions"], { src: "a", dest: "~/.claude/CLAUDE.md" }),
    );
    expect(parse(out)).toMatchObject({
      defaults: { instructions: [{ src: "a", dest: "~/.claude/CLAUDE.md" }] },
    });
  });

  it("refuses what it cannot write safely", () => {
    expect(
      setKey("[defaults]\nmcp = { servers = [] }\n", ["defaults", "mcp"], "x", 1),
    ).toHaveProperty("error");
    expect(addToList('[mcp]\nservers = "x"\n', ["mcp"], "servers", ["y"])).toHaveProperty("error");
    expect(setKey("not toml = = 1", [], "x", 1)).toHaveProperty("error");
  });
  it("keeps comments, handles lists over several lines, headers with comments and implicit tables", () => {
    const text = [
      "[defaults.mcp] # what every machine gets",
      "servers = [",
      '  "fetch", # the first',
      '  "ctx",',
      "] # end",
      "hub = true # the relay serves them",
      "",
    ].join("\n");
    const out = edits(
      text,
      (t) => addToList(t, ["defaults", "mcp"], "servers", ["posthog"]),
      (t) => setKey(t, ["defaults", "mcp"], "hub", false),
      (t) => setKey(t, ["defaults"], "note", "x"),
    );
    const result = "text" in out ? out.text : out.error;
    expect(parse(result)).toEqual({
      defaults: { note: "x", mcp: { servers: ["fetch", "ctx", "posthog"], hub: false } },
    });
    expect(result).toContain("# what every machine gets");
    expect(result).toContain("hub = false # the relay serves them");
    expect(result).toContain('servers = ["fetch", "ctx", "posthog"] # end');
  });

  it("adds tables to a list, skipping ones it has", () => {
    const one = { src: "a", dest: "~/a" };
    const first = text(setKey("", [], "instructions.remove", [one]));
    const again = text(
      addToList(first, [], "instructions.remove", [one, { src: "b", dest: "~/b" }]),
    );
    expect(parse(again)).toEqual({
      "instructions.remove": [one, { src: "b", dest: "~/b" }],
    });
  });
});
