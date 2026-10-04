/**
 * What this machine already has, read without changing anything: skills in
 * every place agents read them, MCP servers in both clients (Claude's project
 * scope too), instruction files, T3 and its providers, and how each agent CLI
 * was installed.
 *
 * Nothing is chosen here. Two copies of one skill, or a server both clients
 * have differently, are both reported; the plan decides what to do with them.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import { exec } from "../Exec.ts";
import { git, ok, out } from "../Git.ts";
import { sha256 } from "../Hash.ts";
import {
  fetchDescriptor,
  isAlive,
  providerPlans,
  resolveAll,
  runtimeFromCommandLine,
} from "../Probe.ts";
import { readT3Settings } from "../T3Settings.ts";
import { fromClaude, fromCodex, secretNamer, type Extracted } from "./Credentials.ts";

/** Where agents read skills, in the order they are reported. */
export const SKILL_ROOTS = ["~/.agents/skills", "~/.claude/skills", "~/.codex/skills"] as const;

/** Instruction files, and where a new fleet keeps each in its repo. */
export const INSTRUCTION_FILES = [
  { dest: "~/.claude/CLAUDE.md", src: "instructions/claude/CLAUDE.md" },
  { dest: "~/.codex/AGENTS.md", src: "instructions/codex/AGENTS.md" },
  { dest: "~/.agents/AGENTS.md", src: "instructions/agents/AGENTS.md" },
] as const;

export interface SkillSource {
  readonly url: string;
  /** Where the skill is within that repository ("." for its root). */
  readonly path: string;
  readonly commit: string;
}

export interface SkillCopy {
  readonly name: string;
  /** The skills directory it was found in, as ~/…. */
  readonly root: string;
  /** What sits in that directory: the skill, or the clone that holds it. Setup moves this aside. */
  readonly entry: string;
  /** The directory holding its SKILL.md. */
  readonly dir: string;
  /** Of every file but .git: two copies with one hash are the same skill. */
  readonly hash: string;
  /** Newest file's modification time, ms. */
  readonly modified: number;
  /** The git repository it was cloned from, when it was. */
  readonly source: SkillSource | null;
  /** Its SKILL.md, to show how it differs. */
  readonly text: string;
  /** How many other files it has, for the diff's label; null when only SKILL.md. */
  readonly files: string | null;
}

export interface FoundServer {
  readonly name: string;
  readonly client: "claude" | "codex";
  /** Claude's project scope: the project's directory, as ~/…; null for user scope. */
  readonly project: string | null;
  /** The client's entry as found: kept in memory only, never written (it holds credentials). */
  readonly entry: Readonly<Record<string, unknown>>;
  readonly extracted: Extracted;
}

export interface FoundInstruction {
  readonly dest: string;
  readonly src: string;
  /** The file as found (a link is followed). */
  readonly at: string;
  readonly text: string;
}

export interface FoundAgent {
  readonly name: "claude" | "codex";
  readonly path: string | null;
  readonly version: string | null;
  readonly installedBy: string | null;
}

export interface FoundT3 {
  readonly running: boolean;
  readonly version: string | null;
  readonly channel: string | null;
  readonly providers: ReadonlyArray<{
    readonly instance: string;
    readonly binary: string | null;
    readonly resolved: string | null;
  }>;
}

export interface Discovery {
  /** A name for this machine, from its hostname. */
  readonly node: string;
  readonly skills: ReadonlyArray<SkillCopy>;
  /** Links into Claude's plugins: the plugin system's, left alone. */
  readonly plugins: ReadonlyArray<{ readonly name: string; readonly at: string }>;
  readonly servers: ReadonlyArray<FoundServer>;
  readonly instructions: ReadonlyArray<FoundInstruction>;
  readonly t3: FoundT3;
  readonly agents: ReadonlyArray<FoundAgent>;
  /** The clients' user-scope entries exactly as found, for the snapshot. */
  readonly raw: {
    readonly claude: Readonly<Record<string, unknown>> | null;
    readonly codex: Readonly<Record<string, unknown>> | null;
  };
  /** What could not be read, and why. */
  readonly unreadable: ReadonlyArray<string>;
}

export const tilde = (p: string, home: string) =>
  home !== "" && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;

const untilde = (p: string, home: string) => (p.startsWith("~/") ? `${home}${p.slice(1)}` : p);

/** A machine name from a hostname: lowercase letters, digits and dashes. */
export const nodeName = (hostname: string) =>
  hostname
    .split(".")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "this-machine";

/** A clone URL without credentials in it. */
export const cleanUrl = (url: string) => url.replace(/^([a-z+]+:\/\/)[^@/]+@/i, "$1");

/** How an agent CLI was installed, from where its binary really lives. */
export const installedBy = (real: string) =>
  real.includes("/node_modules/")
    ? "npm"
    : /\/Cellar\/|^\/opt\/homebrew\/|\/linuxbrew\//.test(real)
      ? "brew"
      : real.includes("/mise/")
        ? "mise"
        : /\/\.local\/share\/claude\/|\/\.claude\/local\//.test(real)
          ? "native installer"
          : real.includes("/.bun/")
            ? "bun"
            : "other";

/** The files of a skill (not .git, not node_modules), hashed, and the newest one's time. */
export const hashSkill = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found = yield* exec({
      command: "find",
      args: [dir, "-type", "f", "-not", "-path", "*/.git/*", "-not", "-path", "*/node_modules/*"],
      timeout: Duration.seconds(30),
    });
    const files = found.stdout.split("\n").filter(Boolean).sort();
    const parts: Array<Uint8Array> = [];
    let modified = 0;
    for (const file of files) {
      const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => new Uint8Array()));
      parts.push(new TextEncoder().encode(`${file.slice(dir.length + 1)}\0`), bytes);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isSome(info) && Option.isSome(info.value.mtime))
        modified = Math.max(modified, info.value.mtime.value.getTime());
    }
    const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      total.set(p, offset);
      offset += p.length;
    }
    const others = files.filter((f) => f !== `${dir}/SKILL.md`).length;
    return {
      hash: yield* Effect.promise(() => sha256(total)),
      modified,
      text: yield* fs.readFileString(`${dir}/SKILL.md`).pipe(Effect.orElseSucceed(() => "")),
      files: others === 0 ? null : `and ${others} other file${others === 1 ? "" : "s"}`,
    };
  });

/** The repository `dir` was cloned from, when its clone is `entry` or inside it. */
const sourceOf = (entry: string, dir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const top = out(yield* git(dir, ["rev-parse", "--show-toplevel"]));
    if (top === "" || !(top === entry || top.startsWith(`${entry}/`))) return null;
    const url = yield* git(top, ["remote", "get-url", "origin"]);
    if (!ok(url) || out(url) === "") return null;
    // Edited or ahead of what it was cloned from: the copy is the user's own, and updating it
    // from the source would lose their work.
    if (out(yield* git(top, ["status", "--porcelain"])) !== "") return null;
    if (out(yield* git(top, ["branch", "-r", "--contains", "HEAD"])) === "") return null;
    return {
      url: cleanUrl(out(url)),
      path: path.relative(top, dir) || ".",
      commit: out(yield* git(top, ["rev-parse", "HEAD"])),
    } satisfies SkillSource;
  });

/** Every skill in the skills directories, as copies: the plan sorts out duplicates. */
export const discoverSkills = (home: string, managed: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    const realOf = (p: string) => fs.realPath(p).pipe(Effect.orElseSucceed(() => p));
    const roots = yield* Effect.forEach(SKILL_ROOTS, (r) => realOf(untilde(r, home)));
    const skills: Array<SkillCopy> = [];
    const plugins: Array<{ name: string; at: string }> = [];
    for (const root of SKILL_ROOTS) {
      const dir = untilde(root, home);
      for (const name of (yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>))).sort()) {
        // .system is Codex's own; dotfiles are nobody's skills.
        if (name.startsWith(".")) continue;
        const entry = path.join(dir, name);
        const link = yield* fs.readLink(entry).pipe(Effect.option);
        if (!(yield* exists(entry))) continue;
        const real = yield* realOf(entry);
        if (Option.isSome(link)) {
          if (real.startsWith(`${yield* realOf(path.join(home, ".claude/plugins"))}/`)) {
            plugins.push({ name, at: tilde(entry, home) });
            continue;
          }
          // Already the fleet's, or another skills directory's (reported there).
          if (managed !== null && real.startsWith(`${managed}/`)) continue;
          if (roots.some((r) => real.startsWith(`${r}/`))) continue;
        }
        const dirs = (yield* exists(path.join(real, "SKILL.md")))
          ? [real]
          : // A clone holding several skills, each in its own folder.
            (yield* exec({
              command: "find",
              args: [real, "-maxdepth", "4", "-name", "SKILL.md", "-not", "-path", "*/.git/*"],
              timeout: Duration.seconds(30),
            })).stdout
              .split("\n")
              .filter(Boolean)
              .map((f) => path.dirname(f))
              .sort();
        for (const skillDir of dirs) {
          const { hash, modified, text, files } = yield* hashSkill(skillDir);
          skills.push({
            name: skillDir === real ? name : path.basename(skillDir),
            root,
            entry,
            dir: skillDir,
            hash,
            modified,
            source: yield* sourceOf(real, skillDir),
            text,
            files,
          });
        }
      }
    }
    return { skills, plugins };
  });

const ClaudeJson = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  projects: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
});

const asTable = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** MCP servers of both clients; `taken` are secret names the fleet already uses. */
export const discoverServers = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  taken: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const unreadable: Array<string> = [];
    const ctx = { home, env, name: secretNamer(taken) };
    const servers: Array<FoundServer> = [];

    const claudeText = yield* fs
      .readFileString(path.join(home, ".claude.json"))
      .pipe(Effect.option);
    let claudeRaw: Readonly<Record<string, unknown>> | null = null;
    if (Option.isSome(claudeText)) {
      const decoded = Schema.decodeOption(Schema.fromJsonString(ClaudeJson))(claudeText.value);
      if (Option.isNone(decoded)) unreadable.push("~/.claude.json is not valid JSON");
      else {
        claudeRaw = decoded.value.mcpServers ?? {};
        for (const [name, entry] of Object.entries(claudeRaw)) {
          const extracted = fromClaude(name, asTable(entry), ctx);
          if (extracted !== null)
            servers.push({
              name,
              client: "claude",
              project: null,
              entry: asTable(entry),
              extracted,
            });
        }
        for (const [project, settings] of Object.entries(decoded.value.projects ?? {}).sort()) {
          for (const [name, entry] of Object.entries(settings.mcpServers ?? {})) {
            const extracted = fromClaude(name, asTable(entry), ctx);
            if (extracted === null) continue;
            servers.push({
              name,
              client: "claude",
              project: tilde(project, home),
              entry: asTable(entry),
              extracted,
            });
          }
        }
      }
    }

    const codexText = yield* fs
      .readFileString(path.join(home, ".codex/config.toml"))
      .pipe(Effect.option);
    let codexRaw: Readonly<Record<string, unknown>> | null = null;
    if (Option.isSome(codexText)) {
      const parsed = yield* Effect.try(() => parseToml(codexText.value)).pipe(Effect.option);
      if (Option.isNone(parsed)) unreadable.push("~/.codex/config.toml is not valid TOML");
      else {
        codexRaw = asTable((parsed.value as Record<string, unknown>)["mcp_servers"]);
        for (const [name, entry] of Object.entries(codexRaw)) {
          const extracted = fromCodex(name, asTable(entry), ctx);
          if (extracted !== null)
            servers.push({
              name,
              client: "codex",
              project: null,
              entry: asTable(entry),
              extracted,
            });
        }
      }
    }
    return { servers, raw: { claude: claudeRaw, codex: codexRaw }, unreadable };
  });

export const discoverInstructions = (home: string, managed: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: Array<FoundInstruction> = [];
    for (const file of INSTRUCTION_FILES) {
      const at = untilde(file.dest, home);
      const real = yield* fs.realPath(at).pipe(Effect.option);
      if (Option.isNone(real)) continue;
      if (managed !== null && real.value.startsWith(`${managed}/`)) continue;
      const text = yield* fs.readFileString(real.value).pipe(Effect.option);
      if (Option.isSome(text)) found.push({ dest: file.dest, src: file.src, at, text: text.value });
    }
    return found;
  });

/**
 * The version an agent CLI's install records in its own files: the native
 * installer's versions/<v>/, Homebrew's Cellar/<name>/<v>/, npm's package.json.
 */
const versionAt = (real: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inPath = /\/(?:versions|Cellar\/[^/]+)\/(\d[^/]*)\//.exec(`${real}/`)?.[1];
    if (inPath !== undefined) return inPath;
    for (let dir = real.slice(0, real.lastIndexOf("/")); dir.includes("/node_modules/");) {
      const text = yield* fs.readFileString(`${dir}/package.json`).pipe(Effect.option);
      if (Option.isSome(text)) {
        const pkg = Schema.decodeUnknownOption(PackageJson)(text.value);
        if (Option.isSome(pkg)) return pkg.value.version;
      }
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
    return null;
  });
const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

/**
 * T3 and the agent CLIs, from their files and the process table: reported,
 * never changed, and never run. (Running `codex --version` writes under
 * ~/.codex, and setup's plan writes nothing; the sync probes run them.)
 */
const discoverRuntime = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = process.env["HOME"] ?? "";
  const agents: Array<FoundAgent> = [];
  for (const name of ["claude", "codex"] as const) {
    const first = (yield* resolveAll(name, process.env["PATH"]))[0] ?? null;
    const real =
      first === null ? null : yield* fs.realPath(first).pipe(Effect.orElseSucceed(() => first));
    agents.push({
      name,
      path: first,
      version: real === null ? null : yield* versionAt(real),
      installedBy: real === null ? null : installedBy(real),
    });
  }
  const runtimeText = yield* fs
    .readFileString(`${home}/.t3/userdata/server-runtime.json`)
    .pipe(Effect.option);
  const runtimeFile = Option.flatMap(runtimeText, Schema.decodeUnknownOption(T3Runtime));
  let running = false;
  let version: string | null = null;
  if (Option.isSome(runtimeFile) && (yield* isAlive(runtimeFile.value.pid))) {
    running = true;
    const descriptor = yield* fetchDescriptor(runtimeFile.value.origin);
    version = Option.isSome(descriptor)
      ? descriptor.value.serverVersion
      : (yield* runtimeFromCommandLine(runtimeFile.value.pid)).version;
  }
  const settings = Option.getOrNull(yield* readT3Settings(home));
  const providers =
    settings === null || settings === "invalid"
      ? []
      : yield* Effect.forEach(
          providerPlans(settings).filter((p) => p.enabled),
          (p) =>
            Effect.gen(function* () {
              const resolved =
                p.binaryPath === null
                  ? null
                  : ((yield* resolveAll(p.binaryPath, process.env["PATH"]))[0] ?? null);
              return { instance: p.instanceId, binary: p.binaryPath, resolved };
            }),
        );
  const t3: FoundT3 = {
    running,
    version,
    channel: version === null ? null : /nightly/.test(version) ? "nightly" : "latest",
    providers,
  };
  return { agents, t3 };
});
const T3Runtime = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Number, origin: Schema.String }),
);

/**
 * Everything setup looks at. `managed` is the fleet's checkout when this
 * machine already has one: links into it are the fleet's, not findings.
 */
export const discover = (options: {
  readonly taken: ReadonlyArray<string>;
  readonly managed: string | null;
}) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const host = (yield* exec({ command: "hostname", timeout: Duration.seconds(5) })).stdout.trim();
    const [{ skills, plugins }, servers, instructions, runtime] = yield* Effect.all(
      [
        discoverSkills(home, options.managed),
        discoverServers(home, process.env, options.taken),
        discoverInstructions(home, options.managed),
        discoverRuntime,
      ],
      { concurrency: "unbounded" },
    );
    return {
      node: nodeName(host),
      skills,
      plugins,
      servers: servers.servers,
      instructions,
      t3: runtime.t3,
      agents: runtime.agents,
      raw: servers.raw,
      unreadable: servers.unreadable,
    } satisfies Discovery;
  });
