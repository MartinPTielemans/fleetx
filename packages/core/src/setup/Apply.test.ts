// A temp directory stands in for the home directory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { linkAll } from "./Apply.ts";
import { snapshotPath, takeSnapshot } from "./State.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("the snapshot and links (the contract with t3-fleet leave)", () => {
  it("takes the snapshot once, mode 600, and records every path moved aside", async () => {
    const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-setup-"));
    const repo = join(home, "fleet");
    fs.mkdirSync(join(repo, "skills/review"), { recursive: true });
    fs.mkdirSync(join(home, ".claude/skills/review"), { recursive: true });
    fs.writeFileSync(join(home, ".claude/skills/review/SKILL.md"), "mine");
    fs.writeFileSync(join(home, ".claude/CLAUDE.md"), "rules");
    const claude = { posthog: { type: "http", url: "https://x" } };
    await run(takeSnapshot(home, 1, { claude, codex: null }));
    // A later setup keeps the first snapshot.
    await run(takeSnapshot(home, 2, { claude: {}, codex: {} }));
    const backups = join(home, ".local/state/t3-fleet/setup/backup/1");
    const links = [
      { path: join(home, ".claude/skills/review"), link: join(home, ".agents/skills/review") },
      { path: join(home, ".agents/skills/review"), link: join(repo, "skills/review") },
      { path: join(home, ".claude/CLAUDE.md"), link: null },
    ];
    await run(linkAll(links, backups, home));
    // Again: what is linked already is left alone.
    expect(await run(linkAll(links, backups, home))).toEqual([
      `0 linked, 0 moved aside to ~/.local/state/t3-fleet/setup/backup/1`,
    ]);

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath(home), "utf8"));
    expect(fs.statSync(snapshotPath(home)).mode & 0o777).toBe(0o600);
    expect(snapshot).toEqual({
      takenAt: 1,
      claude: { mcpServers: claude },
      codex: { mcp_servers: {} },
      moved: [
        {
          path: join(home, ".claude/skills/review"),
          backup: join(backups, ".claude/skills/review"),
        },
        { path: join(home, ".claude/CLAUDE.md"), backup: join(backups, ".claude/CLAUDE.md") },
      ],
    });
    expect(fs.readFileSync(join(backups, ".claude/skills/review/SKILL.md"), "utf8")).toBe("mine");
    expect(fs.readlinkSync(join(home, ".claude/skills/review"))).toBe(
      join(home, ".agents/skills/review"),
    );
    expect(
      fs.lstatSync(join(home, ".claude/CLAUDE.md"), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });
});
