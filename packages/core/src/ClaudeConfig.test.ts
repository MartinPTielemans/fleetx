// Claude's config in temporary homes, written and locked as Claude does.
// @effect-diagnostics nodeBuiltinImport:off
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vite-plus/test";

import { claudeConfigPath, updateClaudeConfig, type ClaudeConfig } from "./ClaudeConfig.ts";

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
): Promise<{ readonly _tag: "Success" | "Failure" }> =>
  Effect.runPromise(effect.pipe(Effect.result, Effect.provide(NodeServices.layer)));

const addServer =
  (name: string) =>
  (config: ClaudeConfig): ClaudeConfig => ({
    ...config,
    mcpServers: { ...(config["mcpServers"] as object), [name]: { type: "stdio", command: name } },
  });

const home = (config: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "t3f-claude-config-"));
  if (config !== null) writeFileSync(join(dir, ".claude.json"), config, { mode: 0o640 });
  return dir;
};
const servers = (file: string) => Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers);

describe("Claude's global config", () => {
  it("waits for Claude's lock, and keeps what Claude wrote while holding it", async () => {
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    // Claude holds its lock: a directory beside the config, fresh.
    mkdirSync(`${file}.lock`);
    const done = Effect.runFork(
      updateClaudeConfig(dir, {}, addServer("fleet")).pipe(Effect.provide(NodeServices.layer)),
    );
    await Effect.runPromise(Effect.sleep("300 millis"));
    expect(servers(file)).toEqual([]);
    // Claude writes under its lock, then lets go.
    writeFileSync(file, '{"mcpServers":{"claudes":{"type":"stdio","command":"c"}}}');
    rmdirSync(`${file}.lock`);
    await Effect.runPromise(Fiber.join(done));
    expect(servers(file)).toEqual(["claudes", "fleet"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("takes over a lock older than proper-lockfile's stale window", async () => {
    const dir = home('{"mcpServers":{}}');
    const file = join(dir, ".claude.json");
    mkdirSync(`${file}.lock`);
    // Its holder stopped refreshing it eleven seconds ago.
    const old = statSync(`${file}.lock`).mtimeMs / 1000 - 11;
    utimesSync(`${file}.lock`, old, old);
    expect((await run(updateClaudeConfig(dir, {}, addServer("fleet"))))._tag).toBe("Success");
    expect(servers(file)).toEqual(["fleet"]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("starts from nothing only when there is no config, and keeps the mode it has", async () => {
    const fresh = home(null);
    await run(updateClaudeConfig(fresh, {}, addServer("fleet")));
    expect(statSync(join(fresh, ".claude.json")).mode & 0o777).toBe(0o600);
    const kept = home('{"numStartups":3,"mcpServers":{}}');
    await run(updateClaudeConfig(kept, {}, addServer("fleet")));
    const file = join(kept, ".claude.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ numStartups: 3 });
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(kept)).toEqual([".claude.json"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "fails without writing, or keeping the lock, when the config cannot be read",
    async () => {
      const dir = home('{"mcpServers":{"mine":{}}}');
      const file = join(dir, ".claude.json");
      chmodSync(file, 0o000);
      expect((await run(updateClaudeConfig(dir, {}, addServer("fleet"))))._tag).toBe("Failure");
      expect(statSync(file).mode & 0o777).toBe(0o000);
      chmodSync(file, 0o600);
      expect(readFileSync(file, "utf8")).toBe('{"mcpServers":{"mine":{}}}');
      expect(existsSync(`${file}.lock`)).toBe(false);
    },
  );

  it("locks beside a symlinked config and writes through to its target", async () => {
    const dir = home(null);
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(join(dir, "dotfiles/claude.json"), '{"mcpServers":{}}', { mode: 0o600 });
    symlinkSync(join(dir, "dotfiles/claude.json"), join(dir, ".claude.json"));
    // Claude's lock is beside the link, not beside the target.
    mkdirSync(join(dir, ".claude.json.lock"));
    const done = Effect.runFork(
      updateClaudeConfig(dir, {}, addServer("fleet")).pipe(Effect.provide(NodeServices.layer)),
    );
    await Effect.runPromise(Effect.sleep("200 millis"));
    expect(servers(join(dir, "dotfiles/claude.json"))).toEqual([]);
    rmdirSync(join(dir, ".claude.json.lock"));
    await Effect.runPromise(Fiber.join(done));
    expect(lstatSync(join(dir, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(servers(join(dir, "dotfiles/claude.json"))).toEqual(["fleet"]);
  });

  it("finds the config where Claude does", async () => {
    const path = (dir: string, env: Record<string, string>) =>
      Effect.runPromise(claudeConfigPath(dir, env).pipe(Effect.provide(NodeServices.layer)));
    const dir = home(null);
    expect(await path(dir, {})).toBe(join(dir, ".claude.json"));
    expect(await path(dir, { CLAUDE_CONFIG_DIR: join(dir, "c") })).toBe(
      join(dir, "c", ".claude.json"),
    );
    expect(await path(dir, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://x" })).toBe(
      join(dir, ".claude-custom-oauth.json"),
    );
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/.config.json"), "{}");
    expect(await path(dir, {})).toBe(join(dir, ".claude/.config.json"));
  });
});
