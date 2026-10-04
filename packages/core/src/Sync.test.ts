// A fleet in a temp directory: a bare remote and three clones, box (authority),
// laptop and omarchy. The repo's part of a sync runs against them for real.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import { loadConfigFrom, type Config } from "./Config.ts";
import { commitAndPush, pullBranch, statusEntries } from "./Git.ts";
import { lastSyncPath } from "./Probe.ts";
import { keepUpdate, land, previewUpdate, removeSkills } from "./SkillSources.ts";
import { approve, listProposals, reject, settleRejection } from "./Staging.ts";
import { exchange, readStates, report } from "./Sync.ts";
import { releaseSyncLock, SYNC_LOCK_ENV, syncLockPath, takeSyncLock, underSyncLock } from "./SyncLock.ts";

const layer = Layer.merge(NodeServices.layer, FetchHttpClient.layer);
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices | import("effect/unstable/http").HttpClient.HttpClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));
const fails = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
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
  put(root, ".config/t3-fleet/gitconfig", "[user]\n\tname = T3 Fleet\n\temail = t3-fleet@localhost\n");
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
    expect(statusEntries(' M skills/a/Ref Guide.md\0?? skills/"q".md\0R  new name.md\0old name.md\0')).toEqual([
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
    expect(await fails(approve(f.box, "main", proposal, "box", "0000000"))).toContain("review it again");
    expect(await fails(reject(f.box, proposal, "0000000"))).toContain("review it again");
    // Laptop changes its proposal after the review.
    put(f.laptop, "skills/a/SKILL.md", "a v3\n");
    await f.sync(f.laptop, "laptop");
    expect(await fails(approve(f.box, "main", proposal, "box", proposal.commit))).toContain("review it again");
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
    expect(await fails(approve(f.box, "main", proposal, "box"))).toContain("conflicts with what reached main");
    expect(onMain(f.origin, "skills/a/SKILL.md")).toBe("a from box\n");
    expect(git(f.box, "status", "--porcelain")).toBe("");
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a from box\n");
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
    put(f.box, "skills/SOURCES.json", `${JSON.stringify({ sources: { upstream: { type: "github", url: upstream, skills: ["a"], paths: { a: "a" } } } })}\n`);
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
    expect(await run(keepUpdate(f.box, ["a"], preview.digest).pipe(Effect.flip))).toContain("preview again");
    expect(read(f.box, "skills/a/SKILL.md")).toBe("a, edited here\n");
  });

  it("removing a skill commits on an authority", async () => {
    const f = makeFleet();
    put(f.box, "skills/SOURCES.json", `${JSON.stringify({ sources: { u: { type: "github", url: "x", skills: ["b"] } } })}\n`);
    commitAll(f.box, "sources");
    const config = await f.config(f.box, "box");
    const landed = await run(removeSkills(f.box, ["b"]).pipe(Effect.flatMap((paths) => land(config, paths, "Remove b"))));
    expect(landed).toContain("committed and pushed");
    expect(onMain(f.origin, "skills/b/SKILL.md")).toBeNull();
  });

  it("commitAndPush refuses while a sync holds the lock", async () => {
    const f = makeFleet();
    put(f.box, "README.md", "x\n");
    const token = await run(takeSyncLock);
    expect(await fails(commitAndPush(f.box, ["README.md"], "readme"))).toContain("a sync is running");
    if (token !== null) await run(releaseSyncLock(token));
    expect(await run(commitAndPush(f.box, ["README.md"], "readme"))).toMatch(/^[0-9a-f]{7,}$/);
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
    writeLock({ pid: process.ppid, start: 0, token: "asleep" });
    execFileSync("touch", ["-t", "200001010000", syncLockPath(process.env["HOME"] ?? "")]);
    expect(await run(takeSyncLock)).toBeNull();
  });

  it("is released only by the run whose token it holds", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    const token = await run(takeSyncLock);
    if (token === null) return expect.unreachable();
    // Another run took it over (this one looked dead to it, say).
    writeLock({ pid: process.ppid, start: 0, token: "theirs" });
    await run(releaseSyncLock(token));
    expect(JSON.parse(read(syncLockPath(process.env["HOME"] ?? ""), "owner.json")).token).toBe("theirs");
  });

  it("lets a process the holder started through, with its token", async () => {
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "t3-fleet-lock-"));
    writeLock({ pid: process.ppid, start: 1, token: "the-sync" });
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
    const results = await run(Effect.forEach([1, 2], () => Effect.result(underSyncLock(Effect.sleep("100 millis"))), { concurrency: 2 }));
    expect(results.filter((r) => r._tag === "Success")).toHaveLength(1);
  });
});

describe("reporting a run", () => {
  const outcome = (config: Config, node: string, at: number, findings: ReadonlyArray<{ key: string; title: string }>, failed = false) => ({
    config,
    node,
    now: at,
    previous: Option.none(),
    failed,
    message: failed ? "pull failed" : "",
    lines: [],
    findings: findings.map((f) => ({ node, key: f.key, severity: "error" as const, area: "sync" as const, title: f.title })),
    applied: [],
    observation: null,
  });

  it("raises an alert once per problem, though its title counts on", async () => {
    const f = makeFleet();
    const config = await f.config(f.box, "box");
    const previous = async () => Option.fromNullishOr((await run(readStates(f.box))).find((s) => s.node === "box"));
    await run(report(outcome(config, "box", 1, [{ key: "sync-failing", title: "failed 3 times" }])));
    await run(report({ ...outcome(config, "box", 2, [{ key: "sync-failing", title: "failed 4 times" }]), previous: await previous() }));
    const state = await run(report({ ...outcome(config, "box", 3, []), previous: await previous() }));
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
      expect(await run(report(outcome(config, "laptop", at, [])).pipe(Effect.flip))).toContain("publishing state");
    }
    expect(readFileSync(lastSyncPath(process.env["HOME"] ?? ""), "utf8")).toMatch(/^4\tfail\t3\tpublishing state/);
  });
});
