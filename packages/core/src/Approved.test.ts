// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { approvedFiles, lastProposalPath, reapplyHeld, settleApproval } from "./Approved.ts";
import { pullBranch } from "./Git.ts";

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

// Real repositories in a temporary home: an origin, the authority's checkout and a member's.
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const FLEET = '[defaults.mcp]\nservers = ["fetch"]\n';
const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-approved-"));
const realHome = process.env["HOME"];
beforeAll(() => {
  process.env["HOME"] = home;
});
afterAll(() => {
  process.env["HOME"] = realHome;
});

/** origin with one commit, the authority's clone and the member's. */
const fleet = (name: string) => {
  const root = join(home, name);
  const origin = join(root, "origin.git");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  const authority = join(root, "authority");
  git(home, "clone", "-q", origin, authority);
  fs.writeFileSync(join(authority, "t3-fleet.toml"), FLEET);
  git(authority, "add", "-A");
  git(authority, "commit", "-qm", "start");
  git(authority, "push", "-q", "origin", "HEAD:main");
  const member = join(root, "member");
  git(home, "clone", "-q", origin, member);
  return { authority, member };
};
/** The member proposes its copy of t3-fleet.toml (recorded as Sync does); the authority approves it with `merged`. */
const proposeAndApprove = (f: ReturnType<typeof fleet>, mine: string, merged: string) => {
  fs.writeFileSync(join(f.member, "t3-fleet.toml"), mine);
  git(f.member, "add", "t3-fleet.toml");
  const proposal = git(
    f.member,
    "commit-tree",
    git(f.member, "write-tree"),
    "-p",
    "HEAD",
    "-m",
    "p",
  );
  git(f.member, "reset", "-q");
  fs.mkdirSync(join(home, ".local/state/t3-fleet"), { recursive: true });
  fs.writeFileSync(lastProposalPath(home), `${proposal}\n`);
  fs.writeFileSync(join(f.authority, "t3-fleet.toml"), merged);
  git(f.authority, "commit", "-qam", "Approve member's proposal (by authority)\n\nt3-fleet.toml");
  git(f.authority, "push", "-q", "origin", "HEAD:main");
};
const settle = async (member: string) => {
  const { dropped, held } = await run(settleApproval(member, "member", "main"));
  await run(pullBranch(member, "main", "ff-only"));
  const lines = await run(reapplyHeld(member, held));
  return { dropped, lines, file: fs.readFileSync(join(member, "t3-fleet.toml"), "utf8") };
};

describe("settleApproval", () => {
  it("drops a copy that is what was proposed, without stashing anything", async () => {
    const f = fleet("same");
    const mine = '[defaults.mcp]\nservers = ["fetch", "notes"]\n';
    proposeAndApprove(f, mine, '[defaults.mcp]\nservers = ["fetch", "posthog", "notes"]\n');
    const { dropped, file } = await settle(f.member);
    expect(dropped).toEqual(["t3-fleet.toml"]);
    expect(file).toContain('"posthog", "notes"');
    expect(git(f.member, "status", "--porcelain")).toBe("");
    expect(git(f.member, "stash", "list")).toBe("");
  });

  it("keeps a later edit, on top of the approved version, and saves the copy", async () => {
    const f = fleet("later");
    proposeAndApprove(
      f,
      '[defaults.mcp]\nservers = ["fetch", "notes"]\n',
      '[defaults.mcp]\nservers = ["fetch", "posthog", "notes"]\n',
    );
    // Edited again after proposing.
    fs.writeFileSync(
      join(f.member, "t3-fleet.toml"),
      '[defaults.mcp]\nservers = ["fetch", "notes", "x"]\n',
    );
    const { lines, file } = await settle(f.member);
    expect(lines[0]).toContain("kept this machine's edit to t3-fleet.toml");
    expect(file).toContain('"x"');
    expect(file).toContain('"posthog"');
    expect(git(f.member, "stash", "list")).toBe("");
  });

  it("carries an unapproved TOML addition across another machine's approved one", async () => {
    const f = fleet("other");
    fs.writeFileSync(
      join(f.authority, "t3-fleet.toml"),
      '[defaults.mcp]\nservers = ["fetch", "posthog"]\n',
    );
    git(
      f.authority,
      "commit",
      "-qam",
      "Approve desktop's proposal (by authority)\n\nt3-fleet.toml",
    );
    git(f.authority, "push", "-q", "origin", "HEAD:main");
    fs.writeFileSync(
      join(f.member, "t3-fleet.toml"),
      '[defaults.mcp]\nservers = ["fetch", "notes"]\n',
    );
    const { file } = await settle(f.member);
    expect(file).toContain('"posthog"');
    expect(file).toContain('"notes"');
  });
});
