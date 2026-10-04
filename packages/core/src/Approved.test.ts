import { describe, expect, it } from "vite-plus/test";

import { approvedFiles } from "./Approved.ts";

describe("approvedFiles", () => {
  it("lists the files approvals of this node's proposals name, and no one else's", () => {
    const log = [
      "Approve desktop's proposal (by laptop)\n\nt3-fleet.toml\nmcp/notes.json\n\u001e",
      "Approve server's proposal (by laptop)\n\nnodes/server.toml\n\u001e",
      "Approve desktop's proposal (by laptop, automatically)\n\nskills/desk/SKILL.md\n\u001e",
      "Set up laptop\n\n\u001e",
    ].join("\n");
    expect(approvedFiles(log, "desktop")).toEqual([
      "t3-fleet.toml",
      "mcp/notes.json",
      "skills/desk/SKILL.md",
    ]);
    expect(approvedFiles(log, "laptop")).toEqual([]);
  });
});
