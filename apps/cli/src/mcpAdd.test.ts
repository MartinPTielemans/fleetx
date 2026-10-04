// `t3-fleet mcp add` and `mcp register-claude`, run as commands against a real
// git repository, a real age key and a temporary home.
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { loadConfigFrom } from "@t3-fleet/core/Config";
import {
  ensureIdentity,
  installSecrets,
  localSecretsPath,
  writeRecipients,
  writeSecrets,
} from "@t3-fleet/core/Secrets";

import { mcpAddCommand, mcpRegisterClaudeCommand } from "./fleet.ts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  process.exitCode = undefined;
});

const git = (repo: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

const run = <E>(effect: Effect.Effect<void, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const add = (...args: Array<string>) => run(Command.runWith(mcpAddCommand, { version: "t" })(args));

/** A fleet of two machines, a (an authority, this one) and b, with its secrets and an origin. */
let repo = "";
let home = "";
beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "t3f-mcp-add-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "remote", "add", "origin", join(root, "origin.git"));
  mkdirSync(join(repo, "nodes"));
  mkdirSync(join(repo, "mcp"));
  writeFileSync(join(repo, "t3-fleet.toml"), '[fleet]\nbranch = "main"\n');
  writeFileSync(join(repo, "nodes/a.toml"), 'roles = ["authority"]\n');
  writeFileSync(join(repo, "nodes/b.toml"), 'roles = ["member"]\n');
  process.env["HOME"] = home;
  process.env["T3_FLEET_CONFIG_REPO"] = repo;
  process.env["T3_FLEET_NODE"] = "a";
  await run(
    Effect.gen(function* () {
      const { recipient } = yield* ensureIdentity;
      yield* writeRecipients(repo, { a: recipient });
      yield* writeSecrets(repo, "EXISTING=1\n");
      yield* installSecrets(repo);
    }),
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fleet");
  git(repo, "push", "-q", "-u", "origin", "main");
});

const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

describe("mcp add", () => {
  it("puts back the files, their index entries and this machine's secrets when the commit is refused", async () => {
    // Something staged before, which must stay staged as it was.
    writeFileSync(join(repo, "nodes/b.toml"), 'roles = ["member"]\n# staged\n');
    git(repo, "add", "nodes/b.toml");
    const stagedBefore = git(repo, "ls-files", "--stage", "nodes/b.toml");
    writeFileSync(join(repo, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const before = {
      a: read("nodes/a.toml"),
      secrets: read("secrets/secrets.env.age"),
      local: readFileSync(localSecretsPath(home), "utf8"),
    };

    await add(
      "github",
      "--command",
      "github-mcp",
      "--env",
      "GITHUB_TOKEN=ghp_x",
      "--node",
      "a",
      "--node",
      "a",
    );

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(repo, "mcp/github.json"))).toBe(false);
    expect(read("nodes/a.toml")).toBe(before.a);
    expect(read("secrets/secrets.env.age")).toBe(before.secrets);
    expect(readFileSync(localSecretsPath(home), "utf8")).toBe(before.local);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("nodes/b.toml\n");
    expect(git(repo, "ls-files", "--stage", "nodes/b.toml")).toBe(stagedBefore);
  });

  it("adopts a server the machine ignored, keeping its credential in the secrets", async () => {
    writeFileSync(
      join(repo, "nodes/a.toml"),
      'roles = ["authority"]\n\n[mcp]\n"ignore.add" = ["figma", "node_repl"]\n',
    );
    git(repo, "commit", "-q", "-am", "ignore figma");
    git(repo, "push", "-q");

    await add(
      "figma",
      "--url",
      "https://figma.example.com/mcp",
      "--header",
      "X-Api-Key: k-123",
      "--node",
      "a",
    );

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(read("mcp/figma.json"))).toEqual({
      kind: "direct",
      url: "https://figma.example.com/mcp",
      headers: { "X-Api-Key": "$FIGMA_X_API_KEY" },
    });
    const config = await Effect.runPromise(
      loadConfigFrom(repo, "a").pipe(Effect.provide(NodeServices.layer)),
    );
    const mcp = config.nodes.find((n) => n.name === "a")?.settings.table["mcp"];
    expect(mcp).toMatchObject({ servers: ["figma"], ignore: ["node_repl"] });
    expect(readFileSync(localSecretsPath(home), "utf8")).toContain("FIGMA_X_API_KEY=k-123");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

describe("mcp register-claude", () => {
  const register = (...args: Array<string>) =>
    run(Command.runWith(mcpRegisterClaudeCommand, { version: "t" })(args));

  it("refuses a server name or a header name a definition could not have", async () => {
    const endpoint = (headers: Record<string, string>) =>
      JSON.stringify({ type: "http", url: "https://x/mcp", tokenEnv: null, headers });
    await register("Bad Name", endpoint({}));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await register("ok", endpoint({ "X-A\nInjected": "v" }));
    expect(process.exitCode).toBe(1);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    process.exitCode = undefined;
    await register("ok", endpoint({ "X-A": "v" }));
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.ok).toEqual({
      type: "http",
      url: "https://x/mcp",
      headers: { "X-A": "v" },
    });
  });
});
