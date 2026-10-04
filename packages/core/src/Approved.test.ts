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

import {
  approvedDir,
  approvedFiles,
  lastProposalPath,
  reapplyHeld,
  restoreHeld,
  settleApproval,
  unmergedStep,
} from "./Approved.ts";
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
  const tree = git(f.member, "write-tree");
  const proposal = git(f.member, "commit-tree", tree, "-p", "HEAD", "-m", "p");
  git(f.member, "reset", "-q");
  fs.mkdirSync(join(home, ".local/state/t3-fleet"), { recursive: true });
  fs.writeFileSync(lastProposalPath(home), `${proposal}\n`);
  commitOn(
    f.authority,
    "t3-fleet.toml",
    merged,
    "Approve member's proposal (by authority)\n\nt3-fleet.toml",
  );
};
const commitOn = (repo: string, file: string, text: string, message: string) => {
  fs.mkdirSync(join(repo, file, ".."), { recursive: true });
  fs.writeFileSync(join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  git(repo, "push", "-q", "origin", "HEAD:main");
};
/** Settle, pull as Sync does with one fetch, then write back or restore. */
const settle = async (member: string) => {
  git(member, "fetch", "-q", "origin", "main");
  const { held, refused } = await run(settleApproval(member, "member", "main"));
  const pulled = await run(Effect.result(pullBranch(member, "main", "ff-only", { fetched: true })));
  const lines =
    pulled._tag === "Success"
      ? await run(reapplyHeld(member, held))
      : (await run(restoreHeld(member, held)), []);
  return { held, refused, pulled, lines };
};
const read = (repo: string, file: string) => fs.readFileSync(join(repo, file), "utf8");
const savedRuns = () => fs.readdirSync(approvedDir(home)).filter((n) => /^\d+$/.test(n));

describe("settleApproval", () => {
  it("drops a copy that is what was proposed, keeping no copy and stashing nothing", async () => {
    const f = fleet("same");
    const before = fs.existsSync(approvedDir(home)) ? savedRuns() : [];
    commitOn(
      f.authority,
      "t3-fleet.toml",
      '[defaults.mcp]\nservers = ["fetch", "posthog"]\n',
      "other",
    );
    proposeAndApprove(
      f,
      '[defaults.mcp]\nservers = ["fetch", "notes"]\n',
      '[defaults.mcp]\nservers = ["fetch", "posthog", "notes"]\n',
    );
    const { held } = await settle(f.member);
    expect(held.map((h) => h.outcome)).toEqual(["proposed"]);
    expect(read(f.member, "t3-fleet.toml")).toContain('["fetch", "posthog", "notes"]');
    expect(git(f.member, "status", "--porcelain")).toBe("");
    expect(git(f.member, "stash", "list")).toBe("");
    expect(savedRuns()).toEqual(before);
  });

  it("puts a later edit on top of the approved version", async () => {
    const f = fleet("later");
    commitOn(
      f.authority,
      "t3-fleet.toml",
      '[defaults.mcp]\nservers = ["fetch", "posthog"]\n',
      "other",
    );
    git(f.member, "fetch", "-q");
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
    const { lines } = await settle(f.member);
    expect(lines[0]).toContain("kept this machine's edit to t3-fleet.toml");
    expect(read(f.member, "t3-fleet.toml")).toContain('["fetch", "posthog", "notes", "x"]');
  });

  it("puts every copy back exactly when the pull fails, and leaves the unmergeable one alone", async () => {
    const f = fleet("fails");
    commitOn(f.authority, "skills/x/SKILL.md", "x\none\ntwo\nthree\n", "x");
    commitOn(f.authority, "skills/y/SKILL.md", "y v1\n", "y");
    git(f.member, "pull", "-q");
    commitOn(f.authority, "skills/x/SKILL.md", "x\none\ntwo\nthree, branch\n", "x again");
    commitOn(f.authority, "skills/y/SKILL.md", "y, branch\n", "y again");
    // x merges cleanly with the branch; y does not.
    fs.writeFileSync(join(f.member, "skills/x/SKILL.md"), "x, mine\none\ntwo\nthree\n");
    fs.writeFileSync(join(f.member, "skills/y/SKILL.md"), "y, mine\n");
    const { held, refused, pulled } = await settle(f.member);
    expect(held.map((h) => [h.file, h.outcome])).toEqual([["skills/x/SKILL.md", "merged"]]);
    expect(refused).toEqual(["skills/y/SKILL.md"]);
    expect(pulled._tag).toBe("Failure");
    expect(read(f.member, "skills/x/SKILL.md")).toBe("x, mine\none\ntwo\nthree\n");
    expect(read(f.member, "skills/y/SKILL.md")).toBe("y, mine\n");
    expect(fs.existsSync(held[0]?.saved ?? "")).toBe(false);

    // The step the refusal names gets past it, and keeps the edit.
    const step = unmergedStep(f.member, refused);
    const stash = /`(git -C \S+ .*?stash push -m t3-fleet -- [^`]+)`/.exec(step)?.[1] ?? "";
    expect(stash).not.toBe("");
    // As written, on a machine where git has no identity of its own.
    execFileSync("sh", ["-c", stash], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "true",
      },
    });
    const again = await settle(f.member);
    expect(again.pulled._tag).toBe("Success");
    expect(read(f.member, "skills/x/SKILL.md")).toBe("x, mine\none\ntwo\nthree, branch\n");
    expect(git(f.member, "stash", "show", "-p")).toContain("y, mine");
  });

  it("merges wherever it runs: a broken repository around its directory is not in play", async () => {
    const f = fleet("broken");
    commitOn(f.authority, "skills/x/SKILL.md", "x\none\ntwo\nthree\n", "x");
    git(f.member, "pull", "-q");
    commitOn(f.authority, "skills/x/SKILL.md", "x\none\ntwo\nthree, branch\n", "x again");
    fs.writeFileSync(join(f.member, "skills/x/SKILL.md"), "x, mine\none\ntwo\nthree\n");
    // Run from inside a worktree whose .git points nowhere.
    const broken = join(home, "broken-worktree");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(join(broken, ".git"), "gitdir: /nonexistent/.git/worktrees/gone\n");
    const cwd = process.cwd();
    process.chdir(broken);
    try {
      const { held, pulled } = await settle(f.member);
      expect(held.map((h) => [h.file, h.outcome])).toEqual([["skills/x/SKILL.md", "merged"]]);
      expect(pulled._tag).toBe("Success");
      expect(read(f.member, "skills/x/SKILL.md")).toBe("x, mine\none\ntwo\nthree, branch\n");
    } finally {
      process.chdir(cwd);
    }
  });

  it("leaves everything as it was when the pull is refused, identical untracked copies included", async () => {
    const f = fleet("refused");
    commitOn(f.authority, "instructions/claude/CLAUDE.md", "rules\n", "instructions");
    commitOn(f.authority, "skills/y/SKILL.md", "y, branch\n", "y");
    // Not pulled yet: an identical copy of the incoming file, and an edit that does not merge.
    fs.mkdirSync(join(f.member, "instructions/claude"), { recursive: true });
    fs.writeFileSync(join(f.member, "instructions/claude/CLAUDE.md"), "rules\n");
    fs.mkdirSync(join(f.member, "skills/y"), { recursive: true });
    fs.writeFileSync(join(f.member, "skills/y/SKILL.md"), "y, mine\n");
    const status = git(f.member, "status", "--porcelain", "-uall");
    const { pulled } = await settle(f.member);
    expect(pulled._tag).toBe("Failure");
    expect(read(f.member, "instructions/claude/CLAUDE.md")).toBe("rules\n");
    expect(read(f.member, "skills/y/SKILL.md")).toBe("y, mine\n");
    expect(git(f.member, "status", "--porcelain", "-uall")).toBe(status);
  });

  it("never touches what sync holds back, and keeps copies only when it must, mode 600", async () => {
    const f = fleet("held");
    commitOn(
      f.authority,
      "t3-fleet.toml",
      '[defaults.mcp]\nservers = ["fetch", "posthog"]\n',
      "other",
    );
    fs.writeFileSync(
      join(f.member, "t3-fleet.toml"),
      '[defaults.mcp]\nservers = ["fetch", "notes"]\n',
    );
    git(f.member, "fetch", "-q", "origin", "main");
    const { held } = await run(
      settleApproval(f.member, "member", "main", new Set(["t3-fleet.toml"])),
    );
    expect(held).toEqual([]);
    expect(read(f.member, "t3-fleet.toml")).toContain("notes");
    // Not held back: saved at 600 until the pull, then gone.
    const settled = await run(settleApproval(f.member, "member", "main"));
    expect(fs.statSync(settled.held[0]?.saved ?? "").mode & 0o777).toBe(0o600);
    await run(pullBranch(f.member, "main", "ff-only", { fetched: true }));
    await run(reapplyHeld(f.member, settled.held));
    expect(fs.existsSync(settled.held[0]?.saved ?? "")).toBe(false);
    expect(read(f.member, "t3-fleet.toml")).toContain('["fetch", "posthog", "notes"]');
  });

  it("prunes old copies", async () => {
    const f = fleet("prune");
    fs.mkdirSync(join(approvedDir(home), "1000", "skills"), { recursive: true });
    fs.writeFileSync(join(approvedDir(home), "1000", "skills", "old"), "old");
    git(f.member, "fetch", "-q", "origin", "main");
    await run(settleApproval(f.member, "member", "main"));
    expect(fs.existsSync(join(approvedDir(home), "1000"))).toBe(false);
  });
});
