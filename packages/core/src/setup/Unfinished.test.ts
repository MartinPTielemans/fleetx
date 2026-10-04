// A run dropped with --abandon, and the next setup finishing it, in a temporary home.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { lastProposalPath } from "../Approved.ts";
import type { ProbeServices } from "../Area.ts";
import { lastSyncPath } from "../Probe.ts";
import { readAbandoned, recordAbandoned, setupProposed, type Abandoned } from "./State.ts";
import { abandonReport, finishWork, nothingUnfinished, unfinishedWork } from "./Unfinished.ts";

const run = <A, E>(effect: Effect.Effect<A, E, ProbeServices>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-unfinished-"));
const realHome = process.env["HOME"];
beforeAll(() => {
  process.env["HOME"] = home;
});
afterAll(() => {
  process.env["HOME"] = realHome;
});

/** A fleet's origin and this machine's checkout, at one commit. */
const checkout = (name: string) => {
  const origin = join(home, name, "origin.git");
  git(home, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(home, name, "fleet");
  git(home, "clone", "-q", origin, repo);
  fs.writeFileSync(join(repo, "t3-fleet.toml"), '[defaults.mcp]\nservers = ["fetch"]\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "start");
  git(repo, "push", "-q", "-u", "origin", "main");
  return { origin, repo };
};
const record = (repo: string, over: Partial<Abandoned> = {}): Abandoned => ({
  startedAt: 1_000,
  abandonedAt: 2_000_000,
  node: "laptop",
  mode: "again",
  checkout: repo,
  commits: true,
  done: ["snapshot", "content", "keys"],
  written: ["mcp/another.json", "t3-fleet.toml", "nodes/laptop.toml"],
  ...over,
});
/** What a run that stopped after `content` left: a new definition and the server listed. */
const halfApplied = (repo: string) => {
  fs.mkdirSync(join(repo, "mcp"), { recursive: true });
  fs.writeFileSync(
    join(repo, "mcp/another.json"),
    '{ "kind": "remote", "url": "https://a.example/mcp" }\n',
  );
  fs.writeFileSync(join(repo, "t3-fleet.toml"), '[defaults.mcp]\nservers = ["fetch", "another"]\n');
};
const synced = (when: number, result = "ok") => {
  fs.mkdirSync(join(lastSyncPath(home), ".."), { recursive: true });
  fs.writeFileSync(lastSyncPath(home), `${Math.round(when / 1000)}\t${result}\t0\t\n`);
};

describe("--abandon", () => {
  it("says what the run did, what it did not, and how to finish or undo it", () => {
    const lines = abandonReport(
      record("/home/u/fleet", { done: ["snapshot", "content", "keys", "commit", "config"] }),
      ["snapshot", "content", "keys", "commit", "config", "links", "sync"],
      "/home/u",
    ).join("\n");
    expect(lines).toContain("✓ wrote its skills, servers and files into /home/u/fleet");
    expect(lines).toContain("✓ committed and pushed them");
    expect(lines).toContain("Not done: links, sync.");
    expect(lines).toContain(
      "run `t3-fleet setup` again. It runs the first sync, which registers its servers",
    );
    expect(lines).toContain('revert its "Set up laptop" commit');
    expect(lines).toContain("~/.config/t3-fleet/config.toml: remove it");
  });
});

describe("the next setup", () => {
  it("publishes what an authority's abandoned run wrote, and knows a sync is still owed", async () => {
    const f = checkout("authority");
    halfApplied(f.repo);
    const a = record(f.repo);
    await run(recordAbandoned(home, a));
    const left = await run(unfinishedWork(home, a, true));
    expect(left).toEqual({
      publish: ["t3-fleet.toml", "mcp/another.json"],
      unpushed: [],
      propose: [],
      sync: true,
    });
    const lines = await run(finishWork(home, a, left, { sync: false }));
    expect(lines[0]).toMatch(/^published t3-fleet\.toml, mcp\/another\.json/);
    expect(git(f.origin, "show", "main:mcp/another.json")).toContain("a.example");
    expect(Option.isNone(await run(readAbandoned(home)))).toBe(true);
    // Synced since, and nothing left in the checkout: nothing is unfinished.
    synced(3_000_000);
    expect(nothingUnfinished(await run(unfinishedWork(home, a, true)))).toBe(true);
    // A sync that failed since does not count.
    synced(3_000_000, "error");
    expect((await run(unfinishedWork(home, a, true))).sync).toBe(true);
  });

  it("pushes what an authority's abandoned run committed when its push failed", async () => {
    const f = checkout("unpushed");
    halfApplied(f.repo);
    git(f.repo, "add", "-A");
    git(f.repo, "commit", "-qm", "Set up laptop");
    const a = record(f.repo);
    synced(3_000_000);
    const left = await run(unfinishedWork(home, a, true));
    expect(left).toEqual({
      publish: [],
      unpushed: ["mcp/another.json", "t3-fleet.toml"],
      propose: [],
      sync: false,
    });
    const lines = await run(finishWork(home, a, left, { sync: false }));
    expect(lines).toEqual([
      "pushed what an earlier run committed: mcp/another.json, t3-fleet.toml",
    ]);
    expect(git(f.origin, "show", "main:mcp/another.json")).toContain("a.example");
  });

  it("marks a member's for proposing, unless it is proposed already as it is", async () => {
    const f = checkout("member");
    halfApplied(f.repo);
    const a = record(f.repo, { commits: false, node: "desktop" });
    synced(3_000_000);
    // The definition went up in a proposal; the fleet file was edited since.
    git(f.repo, "add", "mcp/another.json");
    const proposal = git(f.repo, "commit-tree", git(f.repo, "write-tree"), "-p", "HEAD", "-m", "p");
    git(f.repo, "reset", "-q");
    fs.writeFileSync(lastProposalPath(home), `${proposal}\n`);
    const left = await run(unfinishedWork(home, a, false));
    expect(left).toEqual({ publish: [], unpushed: [], propose: ["t3-fleet.toml"], sync: false });
    await run(finishWork(home, a, left, { sync: false }));
    expect(await run(setupProposed(home))).toEqual(["t3-fleet.toml"]);
  });
});
