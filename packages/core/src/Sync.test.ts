// A fleet in a temp directory: a bare remote and three clones, box (authority),
// laptop and omarchy. The repo's part of a sync runs against them for real.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawn, spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import { loadConfigFrom, type Config } from "./Config.ts";
import { commitAndPush, pullBranch, putBackConflicted, statusEntries } from "./Git.ts";
import { lastSyncPath } from "./Probe.ts";
import { keepUpdate, land, previewUpdate, removeSkills } from "./SkillSources.ts";
import { approve, listProposals, reject, settleRejection } from "./Staging.ts";
import { exchange, readStates, report } from "./Sync.ts";
import { allowSecret, lineHash } from "./SecretScan.ts";
import { stateDir } from "./Names.ts";
import {
  processIdentity,
  releaseSyncLock,
  SYNC_LOCK_ENV,
  syncLockPath,
  takeSyncLock,
  underSyncLock,
} from "./SyncLock.ts";

const layer = Layer.merge(NodeServices.layer, FetchHttpClient.layer);
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    NodeServices.NodeServices | import("effect/unstable/http").HttpClient.HttpClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
const fails = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
/** A file on origin's main, or null when it is not there. */
const onMain = (origin: string, rel: string) => {
  const show = spawnSync("git", ["show", `main:${rel}`], { cwd: origin, encoding: "utf8" });
  return show.status === 0 ? show.stdout : null;
};
const commitAll = (dir: string, message: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
  git(dir, "push", "-q", "origin", "HEAD:main");
};

/** A fresh fleet, and this process's HOME pointed into it. */
const makeFleet = (toml = '[fleet]\nauto_approve = ["skills/"]\n') => {
  const root = mkdtempSync(join(tmpdir(), "t3-fleet-sync-"));
  process.env["HOME"] = root;
  // T3 Fleet's own git config, which git() reads instead of the user's.
  put(
    root,
    ".config/t3-fleet/gitconfig",
    "[user]\n\tname = T3 Fleet\n\temail = t3-fleet@localhost\n",
  );
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const box = join(root, "box");
  git(root, "init", "-q", "-b", "main", "box");
  git(box, "remote", "add", "origin", origin);
  put(box, "t3-fleet.toml", toml);
  put(box, "nodes/box.toml", 'roles = ["authority"]\n');
  put(box, "nodes/laptop.toml", 'roles = ["member"]\n');
  put(box, "nodes/omarchy.toml", 'roles = ["member"]\n');
  put(box, "README.md", "fleet\n");
  put(box, "skills/a/SKILL.md", "a v1\n");
  put(box, "skills/b/SKILL.md", "b v1\n");
  put(box, "skills/a/Ref Guide.md", "line one\n");
  commitAll(box, "fleet");
  git(box, "fetch", "-q", "origin");
  git(box, "branch", "-q", "--set-upstream-to=origin/main");
  git(root, "clone", "-q", origin, "laptop");
  git(root, "clone", "-q", origin, "omarchy");
  const laptop = join(root, "laptop");
  const omarchy = join(root, "omarchy");
  const config = (repo: string, self: string) => run(loadConfigFrom(repo, self));
  /** The repo's part of one sync run on `repo` as `self`. */
  const sync = (repo: string, self: string) =>
    run(
      Effect.gen(function* () {
        const config = yield* loadConfigFrom(repo, self);
        const node = config.nodes.find((n) => n.name === self);
        if (node === undefined) return yield* Effect.die(`no node ${self}`);
        const lines: Array<string> = [];
        const result = yield* underSyncLock(exchange(config, node, lines));
        return { ...result, lines };
      }),
    );
  return { root, origin, box, laptop, omarchy, config, sync };
};

describe("git's own lists", () => {
  it("reads paths with spaces, quotes and renames from -z output", () => {
    expect(
      statusEntries(' M skills/a/Ref Guide.md\0?? skills/"q".md\0R  new name.md\0old name.md\0'),
    ).toEqual([
      { xy: " M", path: "skills/a/Ref Guide.md" },
      { xy: "??", path: 'skills/"q".md' },
      { xy: "R ", path: "new name.md" },
      { xy: "R ", path: "old name.md" },
    ]);
  });
});

describe("approving a proposal", () => {
  it("keeps whatever reached the branch after the proposal was made", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2 from laptop\n");
    const proposed = await f.sync(f.laptop, "laptop");
    expect(proposed.lines.join("\n")).toContain("proposed 1 file");

    // Meanwhile main moves on under skills/: b updated, c added.
    put(f.box, "skills/b/SKILL.md", "b v2\n");
    put(f.box, "skills/c/SKILL.md", "c v1\n");
    commitAll(f.box, "update b, add c");

    const [proposal] = await run(listProposals(f.box, "main"));
    expect(proposal?.files).toEqual(["skills/a/SKILL.md"]);
    if (proposal === undefined) return;
    await run(approve(f.box, "main", proposal, "box", proposal.commit.slice(0, 7)));
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v2 from laptop\n");
    expect(onMain(f.origin, "skills/b/SKILL.md")).toBe("b v2\n");
    expect(onMain(f.origin, "skills/c/SKILL.md")).toBe("c v1\n");
    expect(await run(listProposals(f.box, "main"))).toEqual([]);
  });

  it("on auto-approve, keeps what the authority committed earlier in the same run", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2 from laptop\n");
    await f.sync(f.laptop, "laptop");
    // The authority's own edit, which step 1 of its sync commits.
    put(f.box, "skills/b/SKILL.md", "b v2 from box\n");
    const result = await f.sync(f.box, "box");
    expect(result.failed).toBe(false);
    expect(result.lines.join("\n")).toContain("approved laptop's proposal");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v2 from laptop\n");
    expect(onMain(f.origin, "skills/b/SKILL.md")).toBe("b v2 from box\n");
  });

  it("refuses when the proposal is not the commit reviewed", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    await f.sync(f.laptop, "laptop");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    expect(await fails(approve(f.box, "main", proposal, "box", "0000000"))).toContain(
      "review it again",
    );
    expect(await fails(reject(f.box, proposal, "0000000"))).toContain("review it again");
    // Laptop changes its proposal after the review.
    put(f.laptop, "skills/a/SKILL.md", "a v3\n");
    await f.sync(f.laptop, "laptop");
    expect(await fails(approve(f.box, "main", proposal, "box", proposal.commit))).toContain(
      "review it again",
    );
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v1\n");
  });

  it("keeps the same proposal commit while nothing changes, so a review stays valid", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    await f.sync(f.laptop, "laptop");
    const [first] = await run(listProposals(f.box, "main"));
    await f.sync(f.laptop, "laptop");
    const [second] = await run(listProposals(f.box, "main"));
    expect(second?.commit).toBe(first?.commit);
  });

  it("refuses a proposal that conflicts with the branch, and leaves both as they were", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a from laptop\n");
    await f.sync(f.laptop, "laptop");
    put(f.box, "skills/a/SKILL.md", "a from box\n");
    commitAll(f.box, "box edits a");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    expect(await fails(approve(f.box, "main", proposal, "box"))).toContain(
      "conflicts with what reached main",
    );
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a from box\n");
    expect(git(f.box, "status", "--porcelain")).toBe("");
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a from box\n");
  });

  it("a conflict that also adds a file leaves no conflict markers for the next sync to push", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a from laptop\n");
    put(f.laptop, "skills/a/new.md", "new from laptop\n");
    await f.sync(f.laptop, "laptop");
    put(f.box, "skills/a/SKILL.md", "a from box\n");
    commitAll(f.box, "box edits a");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    expect(await fails(approve(f.box, "main", proposal, "box"))).toContain(
      "conflicts with what reached main",
    );
    expect(git(f.box, "status", "--porcelain")).toBe("");
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a from box\n");
    expect(existsSync(join(f.box, "skills/a/new.md"))).toBe(false);
    // The authority's next sync, auto-approve included, pushes nothing of it.
    const result = await f.sync(f.box, "box");
    expect(result.lines.join("\n")).toContain("could not auto-approve laptop's proposal");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a from box\n");
    expect(onMain(f.origin, "skills/a/new.md")).toBeNull();
    expect(git(f.box, "worktree", "list")).not.toContain("approve");
  });

  it("approves the same change remade on a newer branch, though its commit changed", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    await f.sync(f.laptop, "laptop");
    const [reviewed] = await run(listProposals(f.box, "main"));
    if (reviewed === undefined) return expect.unreachable();
    // Main moves; laptop pulls and proposes the same change on the new base.
    put(f.box, "README.md", "fleet, updated\n");
    commitAll(f.box, "readme");
    await f.sync(f.laptop, "laptop");
    const [now] = await run(listProposals(f.box, "main"));
    expect(now?.commit).not.toBe(reviewed.commit);
    await run(approve(f.box, "main", reviewed, "box", reviewed.commit.slice(0, 7)));
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v2\n");
  });

  it("refuses a re-proposal that only changes indentation, though git's patch id would match", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "if x:\n    a()\nb()\n");
    await f.sync(f.laptop, "laptop");
    const [reviewed] = await run(listProposals(f.box, "main"));
    if (reviewed === undefined) return expect.unreachable();
    put(f.box, "README.md", "fleet, updated\n");
    commitAll(f.box, "readme");
    put(f.laptop, "skills/a/SKILL.md", "if x:\n    a()\n    b()\n");
    await f.sync(f.laptop, "laptop");
    expect(await fails(approve(f.box, "main", reviewed, "box", reviewed.commit))).toContain(
      "review it again",
    );
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v1\n");
  });

  it("auto-approve never writes outside the files a proposal names, though the branch moved one", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/Ref Guide.md", "line one, laptop\n");
    await f.sync(f.laptop, "laptop");
    git(f.box, "mv", "skills/a/Ref Guide.md", "secrets-ish.md");
    git(f.box, "commit", "-qm", "move the guide");
    git(f.box, "push", "-q", "origin", "HEAD:main");
    const result = await f.sync(f.box, "box");
    expect(result.lines.join("\n")).toContain("could not auto-approve laptop's proposal");
    expect(onMain(f.origin, "secrets-ish.md")).toBe("line one\n");
    expect(git(f.box, "status", "--porcelain")).toBe("");
  });

  it("a rejection is all or nothing: no rejected branch when the staging branch stays", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    await f.sync(f.laptop, "laptop");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    // The remote refuses the staging branch's deletion, as a lease would when the node re-proposed meanwhile.
    put(
      f.origin,
      "hooks/update",
      '#!/bin/sh\ncase "$1" in refs/heads/t3-fleet/staging/*) [ "$3" = 0000000000000000000000000000000000000000 ] && exit 1;; esac\nexit 0\n',
    );
    execFileSync("chmod", ["+x", join(f.origin, "hooks/update")]);
    expect(await fails(reject(f.box, proposal, proposal.commit))).toContain("reject failed");
    expect(
      git(f.origin, "for-each-ref", "--format=%(refname)", "refs/heads/t3-fleet/").trim(),
    ).toBe("refs/heads/t3-fleet/staging/laptop");
  });

  it("clears a scratch worktree a dead approve left locked", async () => {
    const f = makeFleet();
    const scratch = join(stateDir(f.root), "approve");
    mkdirSync(stateDir(f.root), { recursive: true });
    git(f.box, "worktree", "add", "-q", "--detach", scratch, "HEAD");
    git(f.box, "worktree", "lock", "--reason", "initializing", scratch);
    execFileSync("rm", ["-rf", scratch]);
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    await f.sync(f.laptop, "laptop");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    await run(approve(f.box, "main", proposal, "box", proposal.commit));
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v2\n");
    expect(git(f.box, "worktree", "list")).not.toContain("approve");
  });

  it("a rejection sets aside only the edits the proposal made", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    await f.sync(f.laptop, "laptop");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    await run(reject(f.box, proposal, proposal.commit));
    // Main moves on elsewhere, and the laptop has an edit of its own there.
    put(f.box, "README.md", "fleet, updated\n");
    commitAll(f.box, "readme");
    put(f.laptop, "README.md", "fleet, laptop's notes\n");
    expect(await run(settleRejection(f.laptop, "laptop", "main"))).toEqual(["skills/a/SKILL.md"]);
    expect(read(f.laptop, "skills/a/SKILL.md")).toBe("a v1\n");
    expect(read(f.laptop, "README.md")).toBe("fleet, laptop's notes\n");
    expect(git(f.laptop, "stash", "list")).toContain("rejected skills/a/SKILL.md");
  });
});

describe("pulling", () => {
  it("a member whose pull failed proposes nothing", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/b/SKILL.md", "b from laptop\n");
    put(f.box, "skills/b/SKILL.md", "b from box\n");
    commitAll(f.box, "box edits b");
    const result = await f.sync(f.laptop, "laptop");
    expect(result.failed).toBe(true);
    expect(result.message).toContain("local edits overlap incoming changes: skills/b/SKILL.md");
    expect(git(f.origin, "for-each-ref", "refs/heads/t3-fleet/")).toBe("");
  });

  it("sees an overlap on a path git would quote, and leaves no conflict in it", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/Ref Guide.md", "line one, laptop\n");
    put(f.box, "skills/a/Ref Guide.md", "line one, box\n");
    commitAll(f.box, "box edits the guide");
    const result = await f.sync(f.laptop, "laptop");
    expect(result.message).toContain("skills/a/Ref Guide.md");
    expect(read(f.laptop, "skills/a/Ref Guide.md")).toBe("line one, laptop\n");
    expect(git(f.laptop, "diff", "--name-only", "--diff-filter=U")).toBe("");
  });

  it("proposes a new file whose name git would quote", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/x/Ref Guide.md", "new\n");
    put(f.laptop, "skills/x/SKILL.md", "x\n");
    const result = await f.sync(f.laptop, "laptop");
    expect(result.lines.join("\n")).toContain("proposed 2 files");
    const [proposal] = await run(listProposals(f.box, "main"));
    expect(proposal?.files).toEqual(["skills/x/Ref Guide.md", "skills/x/SKILL.md"]);
  });

  it("puts every conflicted file back, even one the checkout's HEAD does not have", async () => {
    const f = makeFleet();
    // Local edits, set aside the way --autostash does, then main changes a and deletes b.
    put(f.laptop, "skills/a/SKILL.md", "a, local\n");
    put(f.laptop, "skills/b/SKILL.md", "b, local\n");
    git(f.laptop, "stash", "push", "-q");
    put(f.laptop, "skills/a/SKILL.md", "a, branch\n");
    git(f.laptop, "rm", "-q", "skills/b/SKILL.md");
    git(f.laptop, "commit", "-qam", "branch");
    spawnSync("git", ["stash", "apply"], { cwd: f.laptop });
    expect(
      git(f.laptop, "diff", "--name-only", "--diff-filter=U").trim().split("\n").sort(),
    ).toEqual(["skills/a/SKILL.md", "skills/b/SKILL.md"]);
    expect((await run(putBackConflicted(f.laptop))).sort()).toEqual([
      "skills/a/SKILL.md",
      "skills/b/SKILL.md",
    ]);
    expect(git(f.laptop, "status", "--porcelain")).toBe("");
    expect(read(f.laptop, "skills/a/SKILL.md")).toBe("a, branch\n");
    expect(git(f.laptop, "stash", "list")).not.toBe("");
  });

  it("aborts a conflicted rebase and says so", async () => {
    const f = makeFleet();
    put(f.box, "skills/a/SKILL.md", "a from box\n");
    git(f.box, "commit", "-qam", "box, not pushed yet");
    put(f.laptop, "skills/a/SKILL.md", "a from elsewhere\n");
    commitAll(f.laptop, "pushed first");
    expect(await fails(pullBranch(f.box, "main", "rebase"))).toContain("conflicted");
    expect(existsSync(join(f.box, ".git", "rebase-merge"))).toBe(false);
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a from box\n");
  });

  it("a member with a commit of its own rebases it along, still proposes, and names it", async () => {
    const f = makeFleet();
    put(f.laptop, "README.md", "committed here by hand\n");
    git(f.laptop, "commit", "-qam", "notes");
    const mine = git(f.laptop, "rev-parse", "--short", "HEAD").trim();
    put(f.laptop, "skills/a/SKILL.md", "a v2\n");
    put(f.box, "skills/b/SKILL.md", "b v2\n");
    commitAll(f.box, "b");
    const result = await f.sync(f.laptop, "laptop");
    expect(result.failed).toBe(false);
    expect(result.lines.join("\n")).toContain("proposed 1 file");
    expect(read(f.laptop, "skills/b/SKILL.md")).toBe("b v2\n");
    expect(result.findings.map((x) => x.key)).toEqual(["sync-local-commits"]);
    expect(result.findings[0]?.title).toContain(`${mine} notes`);
    expect(result.findings[0]?.detail).toContain("reset --soft origin/main");
  });

  it("a member fast-forwards, keeping unrelated local edits", async () => {
    const f = makeFleet();
    put(f.laptop, "README.md", "laptop's notes\n");
    put(f.box, "skills/b/SKILL.md", "b v2\n");
    commitAll(f.box, "b");
    expect(await run(pullBranch(f.laptop, "main", "ff-only"))).toBe(1);
    expect(read(f.laptop, "skills/b/SKILL.md")).toBe("b v2\n");
    expect(read(f.laptop, "README.md")).toBe("laptop's notes\n");
  });

  it("an authority commits a deletion it already staged", async () => {
    const f = makeFleet();
    git(f.box, "rm", "-q", "skills/b/SKILL.md");
    const result = await f.sync(f.box, "box");
    expect(result.failed).toBe(false);
    expect(onMain(f.origin, "skills/b/SKILL.md")).toBeNull();
  });

  it("an authority commits its changes even when an auto_commit path does not exist", async () => {
    const f = makeFleet('[fleet]\nauto_commit = ["skills", "claude"]\n');
    put(f.box, "skills/b/SKILL.md", "b v2\n");
    const result = await f.sync(f.box, "box");
    expect(result.failed).toBe(false);
    expect(result.lines).toContain("committed 1 file");
    expect(onMain(f.origin, "skills/b/SKILL.md")).toBe("b v2\n");
  });
});

describe("writes outside sync", () => {
  it("a skills update waits outside the checkout, so a sync before the answer commits nothing", async () => {
    const f = makeFleet();
    const upstream = join(f.root, "upstream");
    put(upstream, "a/SKILL.md", "a upstream v2\n");
    git(f.root, "init", "-q", "upstream");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "v2");
    put(
      f.box,
      "skills/SOURCES.json",
      `${JSON.stringify({ sources: { upstream: { type: "github", url: upstream, skills: ["a"], paths: { a: "a" } } } })}\n`,
    );
    commitAll(f.box, "sources");

    const preview = await run(previewUpdate(f.box, ["a"]));
    expect(preview.diff).toContain("+a upstream v2");
    expect(git(f.box, "status", "--porcelain")).toBe("");
    // A sync while "Keep these changes?" waits.
    const result = await f.sync(f.box, "box");
    expect(result.lines.join("\n")).not.toContain("committed");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v1\n");

    // An edit of the skill's own is never overwritten by keeping the update.
    put(f.box, "skills/a/SKILL.md", "a, edited here\n");
    expect(await run(keepUpdate(f.box, ["a"], preview.digest).pipe(Effect.flip))).toContain(
      "preview again",
    );
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a, edited here\n");
  });

  it("removing a skill commits on an authority", async () => {
    const f = makeFleet();
    put(
      f.box,
      "skills/SOURCES.json",
      `${JSON.stringify({ sources: { u: { type: "github", url: "x", skills: ["b"] } } })}\n`,
    );
    commitAll(f.box, "sources");
    const config = await f.config(f.box, "box");
    const landed = await run(
      removeSkills(f.box, ["b"]).pipe(Effect.flatMap((paths) => land(config, paths, "Remove b"))),
    );
    expect(landed).toContain("committed and pushed");
    expect(onMain(f.origin, "skills/b/SKILL.md")).toBeNull();
  });

  it("commitAndPush refuses while a sync holds the lock", async () => {
    const f = makeFleet();
    put(f.box, "README.md", "x\n");
    const token = await run(takeSyncLock);
    expect(await fails(commitAndPush(f.box, ["README.md"], "readme"))).toContain(
      "a sync is running",
    );
    if (token !== null) await run(releaseSyncLock(token));
    expect(await run(commitAndPush(f.box, ["README.md"], "readme"))).toMatch(/^[0-9a-f]{7,}$/);
  });
});

// Built at run time so this file holds nothing a scanner would flag.
const fakeToken = () => "ghp_" + "aZ3kQ9mX7pL2vB8nR4tY6wC1eF5gH0jK9sD2";

describe("secrets never reach git", () => {
  it("commitAndPush refuses a token in an MCP URL, naming file and line, never the value", async () => {
    const f = makeFleet();
    const key = "3f9a1c2e-7b4d-4e8a-9c1f-2d6b8e0a4c7f";
    put(f.box, "mcp/exa.json", `{\n  "url": "https://mcp.exa.ai/mcp?exaApiKey=${key}"\n}\n`);
    const refused = await fails(commitAndPush(f.box, ["mcp/exa.json"], "Add exa"));
    expect(refused).toContain("mcp/exa.json:2 looks like a token in a URL query (exaApiKey)");
    expect(refused).not.toContain(key);
    expect(onMain(f.origin, "mcp/exa.json")).toBeNull();
    // Left as an edit, not staged for the next commit to take along.
    expect(git(f.box, "status", "--porcelain", "--", "mcp")).toBe("?? mcp/\n");

    // Not a secret after all: allowed by its line's SHA-256, and through.
    const hash = /secrets allow mcp\/exa\.json ([0-9a-f]{64})/.exec(String(refused))?.[1] ?? "";
    expect(await run(allowSecret(f.box, "mcp/exa.json", hash))).toBe(true);
    expect(await run(commitAndPush(f.box, ["mcp/exa.json"], "Add exa"))).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("refuses a token in args", async () => {
    const f = makeFleet();
    put(
      f.box,
      "mcp/x.json",
      `{"args": ["server", "--api-key", "${"Kq8".repeat(4)}Zr72mPw9xLt3"]}\n`,
    );
    expect(await fails(commitAndPush(f.box, ["mcp/x.json"], "x"))).toContain(
      "mcp/x.json:1 looks like a secret in a command-line flag (--api-key)",
    );
  });

  it("commits what `mcp add --token-env` writes: a variable's name is not a secret", async () => {
    const f = makeFleet();
    put(
      f.box,
      "mcp/linear.json",
      `{\n  "kind": "direct",\n  "url": "https://mcp.linear.app/mcp",\n  "auth": {\n    "type": "bearer",\n    "token_env": "T3_FLEET_MCP_TOKEN_LAPTOP"\n  }\n}\n`,
    );
    expect(await run(commitAndPush(f.box, ["mcp/linear.json"], "Add linear"))).toMatch(
      /^[0-9a-f]{7,}$/,
    );
  });

  it("scans only what a commit adds: a skill already holding an example token still updates", async () => {
    const f = makeFleet();
    put(f.box, "skills/a/SKILL.md", `a v1\nEXAMPLE=${fakeToken()}\n`);
    commitAll(f.box, "vendored with an example");
    put(f.box, "skills/a/SKILL.md", `a v2\nEXAMPLE=${fakeToken()}\nAPI_KEY = "your-api-key"\n`);
    expect(await run(commitAndPush(f.box, ["skills/a/SKILL.md"], "update a"))).toMatch(
      /^[0-9a-f]{7,}$/,
    );
  });

  it("an authority's sync holds back the skill with a secret and says why, without its hash", async () => {
    const f = makeFleet();
    put(f.box, "skills/a/SKILL.md", "a v2\n");
    put(f.box, "skills/c/SKILL.md", `token: ${fakeToken()}\n`);
    const result = await f.sync(f.box, "box");
    expect(result.lines.join("\n")).toContain("committed 1 file");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v2\n");
    expect(onMain(f.origin, "skills/c/SKILL.md")).toBeNull();
    const [finding] = result.findings;
    expect(finding?.key).toBe("sync-secret-skills/c");
    expect(finding?.title).toBe(
      "sync will not commit skills/c: skills/c/SKILL.md:1 looks like a GitHub token",
    );
    expect(finding?.detail).toContain("t3-fleet secrets scan");
    expect(JSON.stringify(result.findings)).not.toContain(fakeToken());
    expect(JSON.stringify(result.findings)).not.toMatch(/[0-9a-f]{64}/);
  });

  it("never commits half a skill: a new skill whose script holds a secret stays out whole", async () => {
    const f = makeFleet();
    put(f.box, "skills/new/SKILL.md", "Run scripts/go.sh.\n");
    put(
      f.box,
      "skills/new/scripts/go.sh",
      `curl -H "Authorization: Bearer ${fakeToken().slice(4)}"\n`,
    );
    put(f.box, "skills/SOURCES.json", '{"local": ["new"]}\n');
    put(f.box, "skills/a/SKILL.md", "a v2\n");
    const result = await f.sync(f.box, "box");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v2\n");
    expect(onMain(f.origin, "skills/new/SKILL.md")).toBeNull();
    expect(onMain(f.origin, "skills/new/scripts/go.sh")).toBeNull();
    // Its SOURCES.json entry changed with it, and waits with it.
    expect(onMain(f.origin, "skills/SOURCES.json")).toBeNull();
    expect(result.findings.map((x) => x.key).sort()).toEqual([
      "sync-secret-skills/SOURCES.json",
      "sync-secret-skills/new",
    ]);
  });

  it("a held-back skill an incoming change touches is set aside, and the authority's sync still works", async () => {
    const f = makeFleet();
    put(f.box, "skills/a/SKILL.md", `a, edited\ntoken: ${fakeToken()}\n`);
    // Main moves on under the same file, from elsewhere.
    put(f.laptop, "skills/a/SKILL.md", "a v2 from main\n");
    commitAll(f.laptop, "a v2");
    const result = await f.sync(f.box, "box");
    expect([result.failed, result.message, result.lines]).toEqual([false, "", expect.anything()]);
    expect(result.lines.join("\n")).toContain("pulled 1 commit");
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a v2 from main\n");
    const [finding] = result.findings;
    expect(finding?.key).toBe("sync-secret-skills/a");
    expect(finding?.title).toContain("sync set skills/a aside in git stash");
    // The edit is kept, where the finding says.
    expect(git(f.box, "stash", "list")).toContain("T3 Fleet: held back skills/a");
    expect(git(f.box, "stash", "show", "-p", "stash@{0}")).toContain("a, edited");
    // Later runs keep naming it until the entry is dropped.
    const later = await f.sync(f.box, "box");
    expect(later.failed).toBe(false);
    expect(later.findings.map((x) => [x.key, x.severity])).toEqual([
      ["sync-secret-skills/a", "warn"],
    ]);
  });

  it("a refused skills update leaves nothing behind, so the next sync commits nothing", async () => {
    const f = makeFleet();
    const upstream = join(f.root, "upstream");
    put(upstream, "a/SKILL.md", `a upstream v2\napi_key = "${fakeToken().slice(4)}"\n`);
    git(f.root, "init", "-q", "upstream");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-qm", "v2");
    put(
      f.box,
      "skills/SOURCES.json",
      `${JSON.stringify({ sources: { upstream: { type: "github", url: upstream, skills: ["a"], paths: { a: "a" } } } })}\n`,
    );
    commitAll(f.box, "sources");
    const sources = read(f.box, "skills/SOURCES.json");
    const config = await f.config(f.box, "box");

    const preview = await run(previewUpdate(f.box, ["a"]));
    const refused = await run(
      keepUpdate(f.box, ["a"], preview.digest).pipe(
        Effect.flatMap((paths) => land(config, paths, "Update a")),
        Effect.flip,
      ),
    );
    expect(String(refused)).toContain(
      "skills/a/SKILL.md:2 looks like a secret assigned to api_key",
    );
    // Put back as it was: no fetched files, no advanced pin.
    expect(git(f.box, "status", "--porcelain")).toBe("");
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a v1\n");
    expect(read(f.box, "skills/SOURCES.json")).toBe(sources);

    const result = await f.sync(f.box, "box");
    expect(result.lines.join("\n")).not.toContain("committed");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v1\n");
  });

  it("an authority does not push a commit made by hand that adds a secret", async () => {
    const f = makeFleet();
    put(f.box, "notes/setup.md", `export GITHUB_TOKEN=${fakeToken()}\n`);
    git(f.box, "add", "-A");
    git(f.box, "commit", "-qm", "notes, by hand");
    const result = await f.sync(f.box, "box");
    expect(result.failed).toBe(true);
    expect(onMain(f.origin, "notes/setup.md")).toBeNull();
    expect(result.findings.map((x) => x.key)).toEqual(["sync-secret-notes/setup.md"]);
    expect(result.findings[0]?.title).toContain(
      "sync will not push a commit adding notes/setup.md",
    );

    // commitAndPush checks what rides along too.
    put(f.box, "README.md", "x\n");
    expect(await fails(commitAndPush(f.box, ["README.md"], "readme"))).toContain(
      "notes/setup.md:1 looks like a GitHub token",
    );
    expect(onMain(f.origin, "README.md")).toBe("fleet\n");
  });

  it("a member proposes everything but the skill with a secret, and says why", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", "a v2 from laptop\n");
    put(f.laptop, "skills/d/SKILL.md", `x\nkey = "${fakeToken()}"\n`);
    const result = await f.sync(f.laptop, "laptop");
    expect(result.lines.join("\n")).toContain("proposed 1 file");
    const [proposal] = await run(listProposals(f.box, "main"));
    expect(proposal?.files).toEqual(["skills/a/SKILL.md"]);
    expect(result.findings.map((x) => x.key)).toEqual(["sync-secret-skills/d"]);

    // Only that skill: withdrawn, not proposed empty.
    put(f.laptop, "skills/a/SKILL.md", "a v1\n");
    const again = await f.sync(f.laptop, "laptop");
    expect(again.lines.join("\n")).not.toContain("proposed");
    expect(await run(listProposals(f.box, "main"))).toEqual([]);
  });

  it("a member trusts only the committed allow-list, not its own checkout's", async () => {
    const f = makeFleet();
    const line = `key = "${fakeToken()}"`;
    put(f.laptop, "skills/d/SKILL.md", `${line}\n`);
    const hash = await run(lineHash(line));
    await run(allowSecret(f.laptop, "skills/d/SKILL.md", hash));
    const held = await f.sync(f.laptop, "laptop");
    expect(held.findings.map((x) => x.key)).toEqual(["sync-secret-skills/d"]);

    // An authority allows it on the branch: now it is proposed.
    await run(allowSecret(f.box, "skills/d/SKILL.md", hash));
    commitAll(f.box, "allow");
    git(f.laptop, "checkout", "-q", "--", "t3-fleet.toml");
    const proposed = await f.sync(f.laptop, "laptop");
    expect(proposed.findings).toEqual([]);
    expect(proposed.lines.join("\n")).toContain("proposed 1 file");
  });

  it("an approval refuses a proposal that adds a secret", async () => {
    const f = makeFleet();
    put(f.laptop, "skills/a/SKILL.md", `token: ${fakeToken()}\n`);
    git(f.laptop, "add", "-A");
    git(f.laptop, "commit", "-qm", "by hand");
    git(f.laptop, "push", "-q", "origin", "HEAD:refs/heads/t3-fleet/staging/laptop");
    const [proposal] = await run(listProposals(f.box, "main"));
    if (proposal === undefined) return expect.unreachable();
    const refused = await fails(approve(f.box, "main", proposal, "box", proposal.commit));
    expect(refused).toContain("skills/a/SKILL.md:1 looks like a GitHub token");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a v1\n");
  });
});

describe("the sync lock's owner", () => {
  const writeLock = (owner: object) => {
    const lock = syncLockPath(process.env["HOME"] ?? "");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
  };

  it("is taken over when its process has died, however recent", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    const dead = spawnSync("true").pid ?? 0;
    writeLock({ pid: dead, start: 1, token: "dead" });
    const token = await run(takeSyncLock);
    expect(token).not.toBeNull();
    if (token !== null) await run(releaseSyncLock(token));
    expect(existsSync(syncLockPath(process.env["HOME"] ?? ""))).toBe(false);
  });

  it("stays held while its process lives, however old (a laptop asleep mid-sync)", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    // pid 1 has run since boot, so long before this lock was taken.
    writeLock({ pid: 1, start: await run(Clock.currentTimeMillis), token: "asleep" });
    execFileSync("touch", ["-t", "200001010000", syncLockPath(process.env["HOME"] ?? "")]);
    expect(await run(takeSyncLock)).toBeNull();
  });

  /** What this machine's boot and a process's start read as, from a lock this build took. */
  const identity = async () => {
    const token = await run(takeSyncLock);
    const owner = JSON.parse(read(syncLockPath(process.env["HOME"] ?? ""), "owner.json")) as {
      boot?: string;
      process?: string;
    };
    if (token !== null) await run(releaseSyncLock(token));
    return owner;
  };

  it("is taken over when the machine booted since (a power loss), though its pid lives", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    expect((await identity()).boot).toBeTruthy();
    writeLock({ pid: 1, start: 1, token: "before-boot", boot: "an-earlier-boot" });
    const token = await run(takeSyncLock);
    expect(token).not.toBeNull();
    if (token !== null) await run(releaseSyncLock(token));
  });

  it("is taken over when its pid now belongs to a process started after it", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    const other = spawn("sleep", ["30"]);
    try {
      const { boot } = await identity();
      writeLock({
        pid: other.pid,
        start: await run(Clock.currentTimeMillis),
        token: "reused",
        boot,
        process: "the process that took it",
      });
      const token = await run(takeSyncLock);
      expect(token).not.toBeNull();
      if (token !== null) await run(releaseSyncLock(token));
    } finally {
      other.kill();
    }
  });

  it("stays held when the clock moved since it was taken (the first NTP sync after boot)", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    const other = spawn("sleep", ["30"]);
    try {
      const { boot } = await identity();
      const started = Option.getOrThrow(await run(processIdentity(other.pid ?? 0)));
      // Its start says a day ago: no clock time is compared.
      writeLock({
        pid: other.pid,
        start: (await run(Clock.currentTimeMillis)) - 86_400_000,
        token: "stepped",
        boot,
        process: started,
      });
      expect(await run(takeSyncLock)).toBeNull();
    } finally {
      other.kill();
    }
  });

  it("is released only by the run whose token it holds", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    const token = await run(takeSyncLock);
    if (token === null) return expect.unreachable();
    // Another run took it over (this one looked dead to it, say).
    writeLock({ pid: process.ppid, start: 0, token: "theirs" });
    await run(releaseSyncLock(token));
    expect(JSON.parse(read(syncLockPath(process.env["HOME"] ?? ""), "owner.json")).token).toBe(
      "theirs",
    );
  });

  it("lets a process the holder started through, with its token", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    writeLock({ pid: 1, start: await run(Clock.currentTimeMillis), token: "the-sync" });
    expect(await fails(underSyncLock(Effect.succeed("ran")))).toContain("a sync is running");
    process.env[SYNC_LOCK_ENV] = "the-sync";
    try {
      expect(await run(underSyncLock(Effect.succeed("ran")))).toBe("ran");
      process.env[SYNC_LOCK_ENV] = "another-token";
      expect(await fails(underSyncLock(Effect.succeed("ran")))).toContain("a sync is running");
    } finally {
      delete process.env[SYNC_LOCK_ENV];
    }
  });

  it("lets its holder's own steps through (sync approving), but never a second holder", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    expect(await run(underSyncLock(underSyncLock(Effect.succeed("nested"))))).toBe("nested");
    const results = await run(
      Effect.forEach([1, 2], () => Effect.result(underSyncLock(Effect.sleep("100 millis"))), {
        concurrency: 2,
      }),
    );
    expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
  });
});

describe("reporting a run", () => {
  const outcome = (
    config: Config,
    node: string,
    at: number,
    findings: ReadonlyArray<{ key: string; title: string }>,
    failed = false,
  ) => ({
    config,
    node,
    now: at,
    previous: Option.none(),
    failed,
    message: failed ? "pull failed" : "",
    lines: [],
    findings: findings.map((f) => ({
      node,
      key: f.key,
      severity: "error" as const,
      area: "sync" as const,
      title: f.title,
    })),
    applied: [],
    observation: null,
  });

  it("raises an alert once per problem, though its title counts on", async () => {
    const f = makeFleet();
    const config = await f.config(f.box, "box");
    const previous = async () =>
      Option.fromNullishOr((await run(readStates(f.box))).find((s) => s.node === "box"));
    await run(
      report(outcome(config, "box", 1, [{ key: "sync-failing", title: "failed 3 times" }])),
    );
    await run(
      report({
        ...outcome(config, "box", 2, [{ key: "sync-failing", title: "failed 4 times" }]),
        previous: await previous(),
      }),
    );
    const state = await run(
      report({ ...outcome(config, "box", 3, []), previous: await previous() }),
    );
    expect(state.alerts.map((a) => [a.at, a.kind, a.message])).toEqual([
      [1, "problem", "failed 3 times"],
      [3, "resolved", "failed 4 times"],
    ]);
  });

  it("records the run after publishing, and counts failures there when publishing fails", async () => {
    const f = makeFleet();
    const config = await f.config(f.laptop, "laptop");
    await run(report(outcome(config, "laptop", 1_000, [])));
    expect(readFileSync(lastSyncPath(process.env["HOME"] ?? ""), "utf8")).toMatch(/^1\tok\t0\t/);
    git(f.laptop, "remote", "set-url", "origin", join(f.root, "gone.git"));
    for (const at of [2_000, 3_000, 4_000]) {
      // The published state says streak 0 each time; only the local record knows.
      expect(await run(report(outcome(config, "laptop", at, [])).pipe(Effect.flip))).toContain(
        "publishing state",
      );
    }
    expect(readFileSync(lastSyncPath(process.env["HOME"] ?? ""), "utf8")).toMatch(
      /^4\tfail\t3\tpublishing state/,
    );
  });
});
