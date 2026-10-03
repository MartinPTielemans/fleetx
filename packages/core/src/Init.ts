/**
 * `fleetx init`: start a config repository from what this machine already
 * has. It reads and copies; it changes nothing on the machine. Secrets found
 * in client config (bearer tokens in MCP headers) go into the encrypted
 * secrets file, never into plain files.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import { exec } from "./Exec.ts";
import { commitAndPush, ensureGitConfig, git, ok, why } from "./Git.ts";
import { ensureIdentity, installSecrets, setVar, writeRecipients, writeSecrets } from "./Secrets.ts";

export interface Discovery {
  readonly node: string;
  readonly agents: ReadonlyArray<string>;
  readonly t3: string | null;
  readonly skills: ReadonlyArray<{ readonly name: string; readonly dir: string }>;
  readonly mcp: ReadonlyArray<{ readonly name: string; readonly definition: Record<string, unknown>; readonly secret: { readonly env: string; readonly value: string } | null }>;
  readonly instructions: ReadonlyArray<{ readonly src: string; readonly from: string; readonly dest: string }>;
}

const tilde = (p: string, home: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

const envName = (server: string) => `${server.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`;

export const discover = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = process.env["HOME"] ?? "";
  const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false));
  const host = (yield* exec({ command: "hostname", args: ["-s"], timeout: Duration.seconds(5) })).stdout.trim().toLowerCase();
  const node = host.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "this-machine";

  const agents: Array<string> = [];
  for (const bin of ["claude", "codex"]) {
    if ((yield* exec({ command: "sh", args: ["-c", `command -v ${bin}`], timeout: Duration.seconds(5) })).code === 0) agents.push(bin);
  }
  const runtime = yield* fs.readFileString(path.join(home, ".t3/userdata/server-runtime.json")).pipe(Effect.option);
  const t3 = Option.isSome(runtime) ? "T3 Code" : null;

  const skills: Array<{ name: string; dir: string }> = [];
  for (const dir of [".agents/skills", ".claude/skills", ".codex/skills"].map((d) => path.join(home, d))) {
    for (const name of yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))) {
      if (name.startsWith(".") || skills.some((s) => s.name === name)) continue;
      const at = path.join(dir, name);
      const real = yield* fs.realPath(at).pipe(Effect.orElseSucceed(() => at));
      if (yield* exists(path.join(real, "SKILL.md"))) skills.push({ name, dir: real });
    }
  }

  const mcp: Array<Discovery["mcp"][number]> = [];
  const claudeText = yield* fs.readFileString(path.join(home, ".claude.json")).pipe(Effect.option);
  const claude = Option.isSome(claudeText)
    ? Option.getOrElse(Schema.decodeOption(Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })))(claudeText.value), () => ({}))
    : {};
  for (const [name, raw] of Object.entries((claude as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})) {
    const e = raw as { url?: string; command?: string; args?: Array<string>; headers?: Record<string, string> };
    const auth = e.headers?.["Authorization"] ?? e.headers?.["authorization"];
    const token = auth?.replace(/^Bearer\s+/i, "");
    if (e.url !== undefined) {
      const secret = token ? { env: envName(name), value: token } : null;
      mcp.push({ name, definition: { kind: "direct", url: e.url, ...(secret ? { auth: { type: "bearer", token_env: secret.env } } : {}) }, secret });
    } else if (e.command !== undefined) {
      mcp.push({ name, definition: { kind: "stdio", command: tilde(e.command, home), args: (e.args ?? []).map((a) => tilde(a, home)) }, secret: null });
    }
  }
  const codexText = yield* fs.readFileString(path.join(home, ".codex/config.toml")).pipe(Effect.option);
  if (Option.isSome(codexText)) {
    const parsed = (yield* Effect.try(() => parseToml(codexText.value)).pipe(Effect.orElseSucceed(() => ({})))) as { mcp_servers?: Record<string, Record<string, unknown>> };
    for (const [name, e] of Object.entries(parsed.mcp_servers ?? {})) {
      if (mcp.some((m) => m.name === name)) continue;
      if (typeof e["url"] === "string") {
        const env = typeof e["bearer_token_env_var"] === "string" ? e["bearer_token_env_var"] : null;
        mcp.push({ name, definition: { kind: "direct", url: e["url"], ...(env ? { auth: { type: "bearer", token_env: env } } : {}) }, secret: env && process.env[env] ? { env, value: process.env[env] ?? "" } : null });
      } else if (typeof e["command"] === "string") {
        mcp.push({ name, definition: { kind: "stdio", command: tilde(e["command"], home), args: ((e["args"] as Array<string> | undefined) ?? []).map((a) => tilde(a, home)) }, secret: null });
      }
    }
  }

  const instructions: Array<{ src: string; from: string; dest: string }> = [];
  for (const [rel, src] of [
    [".claude/CLAUDE.md", "claude/CLAUDE.md"],
    [".codex/AGENTS.md", "codex/AGENTS.md"],
  ] as const) {
    const at = path.join(home, rel);
    if (yield* exists(at)) instructions.push({ src, from: at, dest: `~/${rel}` });
  }
  return { node, agents, t3, skills, mcp, instructions } satisfies Discovery;
});

const tomlString = (s: string) => JSON.stringify(s);

/** Definitions are written for people to read and edit. */
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Write a new config repository at `repo` from a discovery. */
export const createRepo = (repo: string, found: Discovery) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = process.env["HOME"] ?? "";
    if (yield* fs.exists(path.join(repo, "fleetx.toml")).pipe(Effect.orElseSucceed(() => false))) {
      return yield* Effect.fail(`${repo} already has a fleetx.toml`);
    }
    for (const dir of ["nodes", "skills", "mcp", "dotfiles"]) yield* fs.makeDirectory(path.join(repo, dir), { recursive: true });

    yield* fs.writeFileString(
      path.join(repo, "fleetx.toml"),
      [
        "# This fleet's settings. Machines are in nodes/; https://github.com/MartinPTielemans/fleetx explains every key.",
        "",
        "[fleet]",
        `checkout = ${tomlString(tilde(repo, home))}`,
        'branch = "main"',
        "interval = 900",
        "alert_after = 3",
        'auto_commit = ["skills"]',
        "",
        "# Settings every machine gets unless its own file or a profile says otherwise.",
        "[defaults.engine]",
        "timer = true",
        "",
        "[defaults.skills]",
        'store = "~/.agents/skills"',
        'clients = ["~/.claude/skills"]',
        'watch = ["~/.codex/skills"]',
        "",
      ].join("\n"),
    );

    const lines = [`# ${found.node}: created by fleetx init.`, 'roles = ["authority"]', ""];
    if (found.instructions.length > 0) {
      for (const i of found.instructions) lines.push("[[instructions]]", `src = ${tomlString(i.src)}`, `dest = ${tomlString(i.dest)}`, "");
    }
    if (found.mcp.length > 0) lines.push("[mcp]", `servers = [${found.mcp.map((m) => tomlString(m.name)).join(", ")}]`, "");
    yield* fs.writeFileString(path.join(repo, "nodes", `${found.node}.toml`), lines.join("\n"));

    for (const skill of found.skills) {
      const copy = yield* exec({ command: "cp", args: ["-R", skill.dir, path.join(repo, "skills", skill.name)], timeout: Duration.seconds(60) });
      if (copy.code !== 0) return yield* Effect.fail(`copying skill ${skill.name}: ${copy.stderr.trim()}`);
    }
    for (const m of found.mcp) {
      yield* fs.writeFileString(path.join(repo, "mcp", `${m.name}.json`), prettyJson(m.definition));
    }
    for (const i of found.instructions) {
      yield* fs.makeDirectory(path.dirname(path.join(repo, i.src)), { recursive: true });
      yield* fs.copyFile(i.from, path.join(repo, i.src));
    }
    yield* fs.writeFileString(path.join(repo, ".gitignore"), "secrets/*\n!secrets/secrets.env.age\n!secrets/recipients.toml\n.DS_Store\n");

    // Secrets: this node's key, and any tokens found, encrypted.
    const { recipient } = yield* ensureIdentity;
    yield* writeRecipients(repo, { [found.node]: recipient });
    let secrets = "";
    for (const m of found.mcp) if (m.secret !== null) secrets = setVar(secrets, m.secret.env, m.secret.value);
    yield* writeSecrets(repo, secrets);

    yield* ensureGitConfig;
    const init = yield* git(repo, ["init", "-q", "-b", "main"]);
    if (!ok(init)) return yield* Effect.fail(`git init: ${why(init)}`);
    yield* git(repo, ["add", "-A"]);
    const commit = yield* git(repo, ["commit", "-q", "-m", `fleetx init on ${found.node}`]);
    if (!ok(commit)) return yield* Effect.fail(`git commit: ${why(commit)}`);
    yield* installSecrets(repo).pipe(Effect.ignore);
    return { recipient };
  });

/** Write this machine's pointer to its config repo. */
export const writeLocalConfig = (repo: string, node: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    yield* fs.makeDirectory(`${home}/.config/fleetx`, { recursive: true });
    yield* fs.writeFileString(`${home}/.config/fleetx/config.toml`, `repo = ${tomlString(tilde(repo, home))}\nnode = ${tomlString(node)}\n`);
  });

/** Add a node to the repo (an authority inviting a machine). */
export const addNode = (repo: string, name: string, ssh: string | null, profiles: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${repo}/nodes/${name}.toml`;
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) return yield* Effect.fail(`nodes/${name}.toml already exists`);
    const lines = [`# ${name}: added by fleetx invite.`, 'roles = ["member"]'];
    if (ssh !== null) lines.push(`ssh = ${tomlString(ssh)}`);
    if (profiles.length > 0) lines.push(`profiles = [${profiles.map(tomlString).join(", ")}]`);
    yield* fs.writeFileString(file, `${lines.join("\n")}\n`);
    return yield* commitAndPush(repo, [`nodes/${name}.toml`], `Invite ${name}`);
  });
