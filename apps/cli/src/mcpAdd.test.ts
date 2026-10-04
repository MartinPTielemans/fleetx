// `t3-fleet mcp add` and `mcp register-claude`, run as commands against a real
// git repository, a real age key and a temporary home.
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

describe("mcp add: hand-written node files", () => {
  const settle = (mcp: string) => {
    writeFileSync(join(repo, "nodes/a.toml"), `roles = ["authority"]\n${mcp}`);
    git(repo, "commit", "-q", "-am", "by hand");
    git(repo, "push", "-q");
  };
  const merged = () =>
    Effect.runPromise(loadConfigFrom(repo, "a").pipe(Effect.provide(NodeServices.layer))).then(
      (config) => config.nodes.find((n) => n.name === "a")?.settings.table["mcp"],
    );

  for (const [label, mcp] of [
    ["a comment after the list", '[mcp]\n"ignore.add" = ["figma"] # local\n'],
    ["a comment after the table", '[mcp] # local\n"ignore.add" = ["figma"]\n'],
    ["a trailing comma", '[mcp]\n"ignore.add" = ["figma"]\n"ignore.remove" = ["other",]\n'],
  ] as const)
    it(`adopts an ignored server with ${label}`, async () => {
      settle(mcp);
      await add("figma", "--url", "https://figma.example.com/mcp", "--node", "a");
      expect(process.exitCode).toBeUndefined();
      expect(git(repo, "log", "-1", "--format=%s")).toBe("Add MCP server figma\n");
      const settings = (await merged()) as { servers: Array<string>; ignore: Array<string> };
      expect(settings.servers).toEqual(["figma"]);
      expect(settings.ignore ?? []).not.toContain("figma");
    });

  it("takes a server off a multi-line ignore list", async () => {
    settle('[mcp]\nignore = [\n  "figma",\n  "other",\n]\n');
    await add("figma", "--url", "https://figma.example.com/mcp", "--node", "a");
    expect(process.exitCode).toBeUndefined();
    expect(await merged()).toMatchObject({ servers: ["figma"], ignore: ["other"] });
  });

  it("refuses, writing nothing, a list it cannot edit safely", async () => {
    // An escaped name: TOML reads "figma", the text edit cannot see it.
    settle('[mcp]\nignore = ["fig\\u006da"]\n');
    const text = read("nodes/a.toml");
    const head = git(repo, "rev-parse", "HEAD");
    await add("figma", "--url", "https://figma.example.com/mcp", "--node", "a");
    expect(process.exitCode).toBe(1);
    expect(read("nodes/a.toml")).toBe(text);
    expect(existsSync(join(repo, "mcp/figma.json"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses a node file that links elsewhere, writing nothing there", async () => {
    mkdirSync(join(repo, "shared"));
    writeFileSync(join(repo, "shared/a.toml"), 'roles = ["authority"]\n');
    rmSync(join(repo, "nodes/a.toml"));
    symlinkSync("../shared/a.toml", join(repo, "nodes/a.toml"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "linked");
    git(repo, "push", "-q");
    const head = git(repo, "rev-parse", "HEAD");
    await add("figma", "--url", "https://figma.example.com/mcp", "--node", "a");
    expect(process.exitCode).toBe(1);
    expect(read("shared/a.toml")).toBe('roles = ["authority"]\n');
    expect(existsSync(join(repo, "mcp/figma.json"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses, before writing anything, when a file it would change is mid-merge", async () => {
    const blob = git(repo, "rev-parse", "HEAD:nodes/a.toml").trim();
    git(repo, "update-index", "--force-remove", "nodes/a.toml");
    execFileSync("git", ["-C", repo, "update-index", "--index-info"], {
      input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tnodes/a.toml\n`).join(""),
    });
    const stages = git(repo, "ls-files", "--stage", "nodes/a.toml");
    await add("figma", "--url", "https://figma.example.com/mcp", "--node", "a");
    expect(process.exitCode).toBe(1);
    expect(git(repo, "ls-files", "--stage", "nodes/a.toml")).toBe(stages);
    expect(existsSync(join(repo, "mcp/figma.json"))).toBe(false);
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
