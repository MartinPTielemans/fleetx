// Real git repositories in a temp directory: a bare origin, the authority's clone, and hub's, which proposes.
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

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const fails = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeServices.layer)));
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();

describe("deciding a proposal", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-fleet-ui-"));
  const fleet = join(root, "fleet");
  const hub = join(root, "hub");
  const skill = (dir: string, text: string) =>
    writeFileSync(join(dir, "skills", "review", "SKILL.md"), `${text}\n`);
  // What the parts of Config these read need; the rest is never touched.
  const config = {
    self: "laptop",
    nodes: [
      { name: "laptop", roles: ["authority"] },
      { name: "hub", roles: ["member"] },
    ],
    repo: fleet,
    branch: "main",
    settings: { table: {} },
  } as unknown as Config;

  /** What a sync on hub does: commit its files on top of origin/main with commit-tree, force-pushed to its staging branch. */
  let syncs = 0;
  const propose = (text: string) => {
    skill(hub, text);
    git(hub, ["fetch", "-q", "origin"]);
    git(hub, ["add", "-A"]);
    const tree = git(hub, ["write-tree"]);
    // A fresh timestamp each time, as a real sync makes: a new commit for the same change.
    const date = `${1_700_000_000 + ++syncs * 60} +0000`;
    const commit = git(hub, ["commit-tree", tree, "-p", "origin/main", "-m", "Proposed by hub"], {
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_DATE: date,
    });
    git(hub, ["push", "-q", "--force", "origin", `${commit}:refs/heads/t3-fleet/staging/hub`]);
    git(hub, ["reset", "-q", "--hard", "origin/main"]);
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
    git(root, ["clone", "-q", join(root, "origin.git"), "hub"]);
  });

  it("still approves the change that was reviewed after a sync re-creates it", async () => {
    const first = propose("v2");
    const [shown] = await run(proposalsOf(config));
    expect(shown).toMatchObject({ node: "hub", commit: first, files: ["skills/review/SKILL.md"] });

    const second = propose("v2");
    expect(second).not.toBe(first);
    const now = await run(proposalFrom(config, "hub", shown!.change));
    expect(now.commit).toBe(second);
  });

  it("refuses a change nobody reviewed", async () => {
    const [shown] = await run(proposalsOf(config));
    propose("v3, which nobody saw");
    expect(await fails(proposalFrom(config, "hub", shown!.change))).toBe(
      "hub's proposal changed since you reviewed it; review it again",
    );
  });

  it("refuses when the branch moved under one of the proposed files", async () => {
    const [shown] = await run(proposalsOf(config));
    skill(fleet, "v1, edited on the branch");
    git(fleet, ["commit", "-qam", "edit"]);
    git(fleet, ["push", "-q", "origin", "main"]);
    expect(await fails(proposalFrom(config, "hub", shown!.change))).toBe(
      "hub's proposal changed since you reviewed it; review it again",
    );
  });
});

describe("where `t3-fleet ui` opens the app (review B-8)", () => {
  it("on the hub once it is up, and here while its bring-up is still to finish", async () => {
    const { hostedApp } = await import("./ui.ts");
    const { writeHub, dropHub } = await import("@t3-fleet/core/setup/Hub");
    const root = mkdtempSync(join(tmpdir(), "t3-fleet-ui-hosted-"));
    const repo = join(root, "fleet");
    mkdirSync(join(repo, "nodes"), { recursive: true });
    writeFileSync(
      join(repo, "t3-fleet.toml"),
      '[relay]\nurl = "https://hub.tailnet.ts.net:8399"\nport = 8399\n\n[ui]\nallow = ["me@example.com"]\n',
    );
    writeFileSync(join(repo, "nodes/laptop.toml"), 'roles = ["authority"]\n');
    writeFileSync(join(repo, "nodes/hub.toml"), 'roles = ["member", "relay"]\n');
    git(root, ["init", "-q", "-b", "main", repo]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "fleet"]);
    mkdirSync(join(root, ".config/t3-fleet"), { recursive: true });
    writeFileSync(
      join(root, ".config/t3-fleet/config.toml"),
      `repo = "${repo}"\nnode = "laptop"\n`,
    );
    const saved = process.env["HOME"];
    process.env["HOME"] = root;
    try {
      const hosted = await run(hostedApp);
      expect(hosted._tag === "Some" ? hosted.value.url : null).toBe(
        "https://hub.tailnet.ts.net:8399/",
      );
      await run(writeHub(root, { node: "hub", ssh: "me@hub", relayUrl: null, error: "no ssh" }));
      expect((await run(hostedApp))._tag).toBe("None");
      await run(dropHub(root));
      expect((await run(hostedApp))._tag).toBe("Some");
      // A hub that cannot serve the app (HubUi.ts): it opens here.
      writeFileSync(
        join(repo, "t3-fleet.toml"),
        '[relay]\nurl = "https://hub.tailnet.ts.net:8399"\nport = 8399\n\n[ui]\nallow = ["me@example.com"]\nhosted = false\n',
      );
      expect((await run(hostedApp))._tag).toBe("None");
    } finally {
      process.env["HOME"] = saved;
    }
  });
});
