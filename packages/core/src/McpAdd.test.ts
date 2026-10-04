import { describe, expect, it } from "vite-plus/test";

import { withMcpServer } from "../../../apps/cli/src/fleet.ts";

describe("withMcpServer", () => {
  it("appends to an existing list, or adds the table", () => {
    expect(
      withMcpServer(
        'roles = ["member"]\n\n[mcp]\n"servers.add" = ["a"]\n\n[codex]\nplugins = []\n',
        "b",
      ),
    ).toBe('roles = ["member"]\n\n[mcp]\n"servers.add" = ["a", "b"]\n\n[codex]\nplugins = []\n');
    expect(withMcpServer('[mcp]\nservers = ["a"]\n', "b")).toBe('[mcp]\nservers = ["a", "b"]\n');
    expect(withMcpServer('roles = ["member"]\n', "b")).toBe(
      'roles = ["member"]\n\n[mcp]\n"servers.add" = ["b"]\n',
    );
  });
});
