// Real git repositories in a temp directory: a bare origin, the authority's clone, and box's, which proposes.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import type { Config } from "@t3-fleet/core/Config";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { proposalFrom, proposalsOf } from "./ui.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const fails = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) => Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)));
const git = (cwd: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

describe("deciding a proposal", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-fleet-ui-"));
  const fleet = join(root, "fleet");
  const box = join(root, "box");
  const skill = (dir: string, text: string) => writeFileSync(join(dir, "skills", "review", "SKILL.md"), `${text}\n`);
  // What the parts of Config these read need; the rest is never touched.
  const config = {
    self: "laptop",
    nodes: [{ name: "laptop", roles: ["authority"] }, { name: "box", roles: ["member"] }],
    repo: fleet,
    branch: "main",
    settings: { table: {} },
  } as unknown as Config;

  /** What a sync on box does: commit its files on top of origin/main with commit-tree, force-pushed to its staging branch. */
  let syncs = 0;
  const propose = (text: string) => {
    skill(box, text);
    git(box, ["fetch", "-q", "origin"]);
    git(box, ["add", "-A"]);
    const tree = git(box, ["write-tree"]);
    // A fresh timestamp each time, as a real sync makes: a new commit for the same change.
    const date = `${1_700_000_000 + ++syncs * 60} +0000`;
    const commit = git(box, ["commit-tree", tree, "-p", "origin/main", "-m", "Proposed by box"], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
    git(box, ["push", "-q", "--force", "origin", `${commit}:refs/heads/t3-fleet/staging/box`]);
    git(box, ["reset", "-q", "--hard", "origin/main"]);
    return commit;
  };

  beforeAll(() => {
    process.env["HOME"] = root;
    git(root, ["init", "-q", "--bare", "-b", "main", "origin.git"]);
    git(root, ["clone", "-q", join(root, "origin.git"), "fleet"]);
    mkdirSync(join(fleet, "skills", "review"), { recursive: true });
    skill(fleet, "v1");
    git(fleet, ["add", "-A"]);
    git(fleet, ["commit", "-qm", "v1"]);
    git(fleet, ["push", "-q", "origin", "main"]);
    git(root, ["clone", "-q", join(root, "origin.git"), "box"]);
  });

  it("still approves the change that was reviewed after a sync re-creates it", async () => {
    const first = propose("v2");
    const [shown] = await run(proposalsOf(config));
    expect(shown).toMatchObject({ node: "box", commit: first, files: ["skills/review/SKILL.md"] });

    const second = propose("v2");
    expect(second).not.toBe(first);
    const now = await run(proposalFrom(config, "box", shown!.change));
    expect(now.commit).toBe(second);
  });

  it("refuses a change nobody reviewed", async () => {
    const [shown] = await run(proposalsOf(config));
    propose("v3, which nobody saw");
    expect(await fails(proposalFrom(config, "box", shown!.change))).toBe("box's proposal changed since you reviewed it; review it again");
  });

  it("refuses when the branch moved under one of the proposed files", async () => {
    const [shown] = await run(proposalsOf(config));
    skill(fleet, "v1, edited on the branch");
    git(fleet, ["commit", "-qam", "edit"]);
    git(fleet, ["push", "-q", "origin", "main"]);
    expect(await fails(proposalFrom(config, "box", shown!.change))).toBe("box's proposal changed since you reviewed it; review it again");
  });
});
