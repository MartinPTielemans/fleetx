// Real git repositories in a temp directory; the effects under test run with Node's services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { branchPrefix } from "./Names.ts";
import { addRenamedSecrets, renameRepo } from "./RepoRename.ts";
import { ensureIdentity, readSecrets, writeRecipients, writeSecrets } from "./Secrets.ts";
import { listProposals } from "./Staging.ts";
import { readStates } from "./Sync.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });

describe("addRenamedSecrets", () => {
  it("adds each FLEETX_ secret under its new name with the same value, once", () => {
    const { text, added } = addRenamedSecrets(
      'A=1\nFLEETX_RELAY_TOKEN="x y"\nexport FLEETX_MCP_TOKEN_MAC=abc\n',
    );
    expect(added).toEqual(["T3_FLEET_RELAY_TOKEN", "T3_FLEET_MCP_TOKEN_MAC"]);
    expect(text).toBe(
      'A=1\nFLEETX_RELAY_TOKEN="x y"\nexport FLEETX_MCP_TOKEN_MAC=abc\nT3_FLEET_RELAY_TOKEN="x y"\nT3_FLEET_MCP_TOKEN_MAC=abc\n',
    );
    expect(addRenamedSecrets(text).added).toEqual([]);
  });
});

describe("renaming a config repo", () => {
  const root = mkdtempSync(join(tmpdir(), "t3-fleet-rename-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "fleet");
  // A one-file commit on a branch, as a node publishes its state.
  const publish = (ref: string, node: string, at: number) => {
    const json = JSON.stringify({
      node,
      at,
      result: "ok",
      streak: 0,
      message: "",
      rev: "",
      observation: null,
      findings: [],
      applied: [],
      alerts: [],
    });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: json,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: repo,
      input: `100644 blob ${blob}\tstate.json\n`,
      encoding: "utf8",
    }).trim();
    const commit = git(repo, "commit-tree", tree, "-m", "state").trim();
    git(repo, "push", "-q", "origin", `${commit}:refs/heads/${ref}`);
  };

  beforeAll(async () => {
    process.env["HOME"] = root;
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "clone", "-q", origin, "fleet");
    mkdirSync(join(repo, "nodes"));
    writeFileSync(join(repo, "fleetx.toml"), '[fleet]\nbranch = "main"\n');
    writeFileSync(
      join(repo, "nodes", "box.toml"),
      'roles = ["authority"]\n[mcp]\ntoken_env = "FLEETX_MCP_TOKEN_BOX"\n',
    );
    const { recipient } = await run(ensureIdentity);
    await run(writeRecipients(repo, { box: recipient }));
    await run(writeSecrets(repo, "FLEETX_RELAY_TOKEN=r\nFLEETX_MCP_TOKEN_BOX=b\n"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fleet");
    git(repo, "push", "-q", "origin", "HEAD:main");
    publish("fleetx/state/box", "box", 1);
    publish("fleetx/state/laptop", "laptop", 1);
    publish("t3-fleet/state/laptop", "laptop", 2);
    // A proposal: one more commit on top of main.
    writeFileSync(join(repo, "extra.txt"), "x\n");
    git(repo, "add", "extra.txt");
    git(repo, "commit", "-qm", "proposal");
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/fleetx/staging/laptop");
    git(repo, "reset", "-q", "--hard", "HEAD~1");
  });

  it("reads both names before the rename, a node's newer state winning", async () => {
    expect(branchPrefix(repo, "state")).toBe("fleetx/state/");
    const states = await run(readStates(repo));
    expect(states.map((s) => [s.node, s.at]).sort()).toEqual([
      ["box", 1],
      ["laptop", 2],
    ]);
    expect((await run(listProposals(repo, "main"))).map((p) => p.branch)).toEqual([
      "fleetx/staging/laptop",
    ]);
  });

  it("moves the file and the branches, and adds the secrets under their new names", async () => {
    // An unrelated local edit stays where it is, uncommitted.
    writeFileSync(
      join(repo, "nodes", "box.toml"),
      'roles = ["authority"]\n[mcp]\ntoken_env = "FLEETX_MCP_TOKEN_BOX"\n# local\n',
    );
    const done = await run(renameRepo(repo, "main"));
    expect(git(repo, "status", "--porcelain").trim()).toBe("M nodes/box.toml");
    git(repo, "checkout", "--", "nodes/box.toml");
    expect(done.join("\n")).toContain("fleetx.toml → t3-fleet.toml");
    expect(existsSync(join(repo, "t3-fleet.toml"))).toBe(true);
    // Variable names agents read from T3's environment stay until 1.0.
    expect(readFileSync(join(repo, "nodes", "box.toml"), "utf8")).toContain(
      'token_env = "FLEETX_MCP_TOKEN_BOX"',
    );
    const secrets = await run(readSecrets(repo));
    expect(secrets).toContain("FLEETX_RELAY_TOKEN=r");
    expect(secrets).toContain("T3_FLEET_RELAY_TOKEN=r");
    expect(secrets).toContain("T3_FLEET_MCP_TOKEN_BOX=b");
    const branches = git(origin, "for-each-ref", "--format=%(refname:strip=2)", "refs/heads/")
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(branches).toEqual([
      "main",
      "t3-fleet/staging/laptop",
      "t3-fleet/state/box",
      "t3-fleet/state/laptop",
    ]);
    // The newer state under the new name was kept, not replaced by the older one.
    expect((await run(readStates(repo))).find((s) => s.node === "laptop")?.at).toBe(2);
    expect(branchPrefix(repo, "state")).toBe("t3-fleet/state/");
    expect((await run(listProposals(repo, "main"))).map((p) => p.branch)).toEqual([
      "t3-fleet/staging/laptop",
    ]);
  });

  it("does nothing the second time", async () => {
    expect(await run(renameRepo(repo, "main"))).toEqual([]);
  });
});

describe("renaming with other work staged", () => {
  it("commits only the rename's own files, leaving the rest staged", async () => {
    const root = mkdtempSync(join(tmpdir(), "t3-fleet-rename-staged-"));
    process.env["HOME"] = root;
    const origin = join(root, "origin.git");
    const repo = join(root, "fleet");
    git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(root, "init", "-q", "-b", "main", "fleet");
    git(repo, "remote", "add", "origin", origin);
    mkdirSync(join(repo, "nodes"));
    writeFileSync(join(repo, "fleetx.toml"), '[fleet]\nbranch = "main"\n');
    writeFileSync(join(repo, "nodes", "box.toml"), 'roles = ["authority"]\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fleet");
    git(repo, "push", "-q", "-u", "origin", "HEAD:main");
    // A staged, half-finished edit.
    writeFileSync(join(repo, "nodes", "box.toml"), 'roles = ["authority"]\n# WIP, not ready\n');
    git(repo, "add", "nodes/box.toml");

    await run(renameRepo(repo, "main"));
    expect(
      git(origin, "show", "--name-only", "--no-renames", "--format=", "main")
        .trim()
        .split("\n")
        .sort(),
    ).toEqual(["fleetx.toml", "t3-fleet.toml"]);
    expect(git(repo, "status", "--porcelain").trim()).toBe("M  nodes/box.toml");
  });
});
