/**
 * `t3-fleet leave`: take this machine out of the fleet and leave it working on
 * its own. Planning only reads; each step says exactly what it will do, and
 * runs only once the person has seen the plan.
 *
 *   fleet       an authority commits the removal of nodes/<name>.toml and the
 *               machine's secrets recipient; a member proposes it, for an
 *               authority to approve. The only authority is refused.
 *   services    the sync timer, `listen`, `relay serve` and the model proxy,
 *               stopped and their units removed (launchd or systemd)
 *   links       every T3 Fleet link into the config repo (skills in the store
 *               and client directories, dotfiles, instructions) becomes a real
 *               copy of what it pointed to
 *   models      T3's provider instances pointed back at what they ran before,
 *               and the launchers removed
 *   mcp         with setup's snapshot, T3 Fleet's registrations in Claude and
 *               Codex give way to the user's original entries, and what setup
 *               moved aside goes back; without one they are kept
 *   purge       only with --purge: ~/.config/t3-fleet, ~/.local/state/t3-fleet
 *               and the installed bundle
 *
 * The config repo checkout is never deleted.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { sh, shPath } from "./Area.ts";
import { expandHome, type Config } from "./Config.ts";
import { exec } from "./Exec.ts";
import { commitAndPush, git, literal, ok, out, why } from "./Git.ts";
import { routeProvider } from "./models/Route.ts";
import {
  branchPrefix,
  CLI,
  configDir,
  isLauncher,
  launchdLabel,
  SHARE_DIR,
  stateDir,
  systemdUnit,
} from "./Names.ts";
import {
  decryptWith,
  encryptedPath,
  encryptFor,
  keyPath,
  readRecipients,
  recipientsPath,
  varNames,
  writeRecipients,
  writeSecrets,
} from "./Secrets.ts";
import { underSyncLock } from "./SyncLock.ts";
import { providerPlans, readT3Settings, t3SettingsPath } from "./T3Settings.ts";

/** What setup recorded before it changed anything (written by `t3-fleet setup`). */
export const SetupSnapshot = Schema.Struct({
  takenAt: Schema.Number,
  claude: Schema.optionalKey(
    Schema.Struct({
      mcpServers: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  ),
  codex: Schema.optionalKey(
    Schema.Struct({
      mcp_servers: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      ),
    }),
  ),
  moved: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, backup: Schema.String })),
  ),
});
export type SetupSnapshot = typeof SetupSnapshot.Type;

/** ~/.local/state/t3-fleet/setup/before.json */
export const setupSnapshotPath = (home: string) => `${stateDir(home)}/setup/before.json`;

export interface LeaveStep {
  readonly title: string;
  /** Exactly what it does: commands, paths, entries. */
  readonly lines: ReadonlyArray<string>;
  /** Runs the step; its result is a line or two on what it did. */
  readonly apply: Effect.Effect<
    ReadonlyArray<string>,
    string,
    | FileSystem.FileSystem
    | Path.Path
    | import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
  >;
}

export interface LeavePlan {
  readonly node: string;
  readonly repo: string;
  /** Why this machine cannot leave; when set, nothing runs. */
  readonly refusal: string | null;
  readonly steps: ReadonlyArray<LeaveStep>;
  /** What stays, and what the person still has to do. */
  readonly notes: ReadonlyArray<string>;
}

export interface LeaveOptions {
  readonly home: string;
  readonly purge: boolean;
  /** For tests; this machine's otherwise. */
  readonly platform?: string;
  readonly root?: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): Array<string> =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(SetupSnapshot));

const message = (e: string | { readonly message: string }) =>
  typeof e === "string" ? e : e.message;

const tilde = (p: string, home: string) =>
  p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;

/** Runs a step's shell with this home; fails with the output when it fails. */
const shell = (script: string, home: string) =>
  exec({
    command: "sh",
    args: ["-c", script],
    env: { HOME: home },
    extendEnv: true,
    timeout: Duration.minutes(3),
  }).pipe(
    Effect.flatMap((r) =>
      r.code === 0
        ? Effect.succeed(r.stdout.trim())
        : Effect.fail(
            (r.stderr.trim() || r.stdout.trim() || r.spawnError || "failed")
              .split("\n")
              .slice(-3)
              .join("\n"),
          ),
    ),
  );

// ---- services ---------------------------------------------------------------

/** T3 Fleet's services and timers, with the stop launchd gives each one before it kills it. */
const ROLES = [
  { role: "sync", what: "the sync timer", exitTimeout: 20 },
  { role: "listen", what: "the listener", exitTimeout: 20 },
  { role: "serve", what: "the relay", exitTimeout: 20 },
  // The proxy drains the responses in flight (Launchers.ts, STOP_TIMEOUT_SECONDS).
  { role: "models", what: "the model proxy", exitTimeout: 75 },
] as const;

/** Shell that stops one service or timer and removes its unit files. */
export const removeService = (
  platform: string,
  root: boolean,
  role: string,
  exitTimeout: number,
) => {
  if (platform === "darwin") {
    const job = `"gui/$(id -u)/${launchdLabel(role)}"`;
    return [
      `launchctl bootout ${job} 2>/dev/null`,
      `i=0; while launchctl print ${job} >/dev/null 2>&1 && [ "$i" -lt ${exitTimeout + 10} ]; do sleep 1; i=$((i + 1)); done`,
      `rm -f "$HOME/Library/LaunchAgents/${launchdLabel(role)}.plist"`,
    ].join("\n");
  }
  const unit = systemdUnit(role);
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  const units = role === "sync" ? [`${unit}.timer`, `${unit}.service`] : [`${unit}.service`];
  return [
    `${ctl} disable --now ${units.join(" ")} 2>/dev/null`,
    `rm -f ${units.map((u) => `${dir}/${u}`).join(" ")}`,
    `${ctl} daemon-reload`,
  ].join("\n");
};

const servicesStep = (home: string, platform: string, root: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const found: Array<{ what: string; script: string }> = [];
    for (const r of ROLES) {
      const unit =
        platform === "darwin"
          ? `${home}/Library/LaunchAgents/${launchdLabel(r.role)}.plist`
          : root
            ? `/etc/systemd/system/${systemdUnit(r.role)}.${r.role === "sync" ? "timer" : "service"}`
            : `${home}/.config/systemd/user/${systemdUnit(r.role)}.${r.role === "sync" ? "timer" : "service"}`;
      if (yield* fs.exists(unit).pipe(Effect.orElseSucceed(() => false)))
        found.push({ what: r.what, script: removeService(platform, root, r.role, r.exitTimeout) });
    }
    if (found.length === 0) return null;
    const script = found.map((f) => f.script).join("\n");
    return {
      title: `Stop and remove ${found.map((f) => f.what).join(", ")}`,
      lines: script.split("\n").map((l) => `$ ${l}`),
      apply: shell(script, home).pipe(
        Effect.as([`stopped ${found.map((f) => f.what).join(", ")}`]),
      ),
    } satisfies LeaveStep;
  });

// ---- links ------------------------------------------------------------------

/**
 * Every link of T3 Fleet's that resolves into the config repo: entries of the
 * skills store, client and watched directories, and dotfile and instruction
 * destinations. Each is replaced by a copy of what it resolves to now.
 */
const linksStep = (config: Config, home: string, table: Json, skip: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* fs.realPath(config.repo).pipe(Effect.orElseSucceed(() => config.repo));
    const inRepo = (p: string) => p === repo || p.startsWith(`${repo}/`);
    const skills = isObject(table["skills"]) ? table["skills"] : {};
    const dirs = [
      typeof skills["store"] === "string" ? skills["store"] : "~/.agents/skills",
      ...strings(skills["clients"]),
      ...strings(skills["watch"]),
    ].map((d) => expandHome(d, home));
    const candidates: Array<string> = [];
    for (const dir of new Set(dirs)) {
      for (const name of yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
        candidates.push(path.join(dir, name));
    }
    for (const area of ["dotfiles", "instructions"]) {
      const entries = Array.isArray(table[area]) ? table[area] : [];
      for (const e of entries)
        if (isObject(e) && typeof e["dest"] === "string")
          candidates.push(expandHome(e["dest"], home));
    }
    const links: Array<{ at: string; target: string }> = [];
    for (const at of new Set(candidates)) {
      if (skip.has(at)) continue;
      if (Option.isNone(yield* fs.readLink(at).pipe(Effect.option))) continue;
      const target = yield* fs.realPath(at).pipe(Effect.option);
      if (Option.isSome(target) && inRepo(target.value)) links.push({ at, target: target.value });
    }
    if (links.length === 0) return null;
    return {
      title: `Turn ${links.length} link${links.length === 1 ? "" : "s"} into the config repo into real copies`,
      lines: links.map((l) => `${tilde(l.at, home)}  ← copy of ${tilde(l.target, home)}`),
      // Every target is resolved before any link changes, so a client link through the store copies the repo's skill.
      apply: Effect.forEach(links, (l) =>
        Effect.gen(function* () {
          const tmp = `${l.at}.t3-fleet-leave`;
          yield* fs.remove(tmp, { recursive: true, force: true });
          yield* fs.copy(l.target, tmp);
          yield* fs.remove(l.at);
          yield* fs.rename(tmp, l.at);
        }).pipe(
          Effect.mapError(
            (e) => `copying ${tilde(l.target, home)} to ${tilde(l.at, home)}: ${e.message}`,
          ),
        ),
      ).pipe(Effect.as([`copied ${links.length} link${links.length === 1 ? "" : "s"} into place`])),
    } satisfies LeaveStep;
  });

// ---- models -----------------------------------------------------------------

const modelsStep = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* readT3Settings(home);
    const backup = `${t3SettingsPath(home)}.t3-fleet-models-backup`;
    const hasBackup = yield* fs.exists(backup).pipe(Effect.orElseSucceed(() => false));
    const routed =
      Option.isSome(settings) && settings.value !== "invalid"
        ? providerPlans(settings.value).filter(
            (p) =>
              p.binaryPath !== null &&
              isLauncher(p.binaryPath.slice(p.binaryPath.lastIndexOf("/") + 1)),
          )
        : [];
    const bin = `${home}/.local/bin`;
    const launchers = (yield* fs
      .readDirectory(bin)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter(isLauncher)
      .sort();
    if (routed.length === 0 && launchers.length === 0) return null;
    const lines = [
      ...routed.map(
        (p) =>
          `${p.instanceId}: ${hasBackup ? `$ ${CLI} models route ${p.instanceId} --undo` : `binaryPath removed, so T3 runs its default ${p.driver}`}`,
      ),
      ...launchers.map((l) => `$ rm ~/.local/bin/${l}`),
    ];
    return {
      title: "Point T3's providers back at what they ran before, and remove the launchers",
      lines,
      apply: Effect.gen(function* () {
        const done: Array<string> = [];
        for (const p of routed) {
          const result = yield* routeProvider(home, p.instanceId, null, { undo: hasBackup }).pipe(
            Effect.mapError((e) => `${p.instanceId}: ${e.message}`),
          );
          done.push(`${p.instanceId} runs ${result.now ?? "T3's default"}`);
        }
        for (const l of launchers)
          yield* fs
            .remove(`${bin}/${l}`)
            .pipe(Effect.mapError((e) => `removing ${l}: ${e.message}`));
        if (launchers.length > 0) done.push(`removed ${launchers.join(", ")}`);
        return done;
      }),
    } satisfies LeaveStep;
  });

// ---- mcp --------------------------------------------------------------------

/** Claude's and Codex's user-level registrations, as they are now. */
const readRegistrations = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claudeText = yield* fs.readFileString(`${home}/.claude.json`).pipe(Effect.option);
    const claudeJson = Option.isSome(claudeText)
      ? Option.getOrUndefined(decodeJson(claudeText.value))
      : undefined;
    const claude =
      isObject(claudeJson) && isObject(claudeJson["mcpServers"])
        ? (claudeJson["mcpServers"] as Record<string, unknown>)
        : {};
    const codexText = yield* fs.readFileString(`${home}/.codex/config.toml`).pipe(Effect.option);
    const codexToml = Option.isSome(codexText)
      ? yield* Effect.try(() => parseToml(codexText.value) as Json).pipe(
          Effect.orElseSucceed(() => ({}) as Json),
        )
      : {};
    const codex = isObject(codexToml["mcp_servers"])
      ? (codexToml["mcp_servers"] as Record<string, unknown>)
      : {};
    return { claude, codex };
  });

const commandOf = (entry: unknown) =>
  isObject(entry) && typeof entry["command"] === "string" ? entry["command"] : null;
const urlOf = (entry: unknown) =>
  isObject(entry) && typeof entry["url"] === "string" ? entry["url"] : null;

/** One Codex server as the TOML table `codex mcp add` would have written. */
export const codexTable = (name: string, entry: Json) =>
  stringifyToml({ mcp_servers: { [name]: entry } });

const mcpStep = (home: string, table: Json, snapshot: SetupSnapshot | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mcp = isObject(table["mcp"]) ? table["mcp"] : {};
    const declared = new Set(strings(mcp["servers"]));
    const gateway = typeof mcp["gateway"] === "string" ? mcp["gateway"].replace(/\/+$/, "") : null;
    const current = yield* readRegistrations(home);
    const ours = (name: string, entry: unknown) =>
      declared.has(name) || (commandOf(entry)?.replace(/^.*\//, "") ?? "") === CLI;
    const has = (bin: string) =>
      exec({ command: "sh", args: ["-c", `command -v ${bin}`], timeout: Duration.seconds(5) }).pipe(
        Effect.map((r) => r.code === 0),
      );
    const clients = { claude: yield* has("claude"), codex: yield* has("codex") };
    const notes: Array<string> = [];

    if (snapshot === null) {
      // Kept: they work without T3 Fleet. Hub ones need the relay to keep running.
      const viaHub = [
        ...Object.entries(current.claude).map(([n, e]) => ({ n, e, c: "Claude" })),
        ...Object.entries(current.codex).map(([n, e]) => ({ n, e, c: "Codex" })),
      ].filter(({ n, e }) => {
        const url = urlOf(e);
        return declared.has(n) && url !== null && gateway !== null && url.startsWith(`${gateway}/`);
      });
      const self = [
        ...Object.entries(current.claude).map(([n, e]) => ({ n, e, c: "Claude" })),
        ...Object.entries(current.codex).map(([n, e]) => ({ n, e, c: "Codex" })),
      ].filter(({ n, e }) => !declared.has(n) && ours(n, e));
      notes.push(
        "MCP: no setup snapshot here (this machine joined before `t3-fleet setup`), so Claude's and Codex's registrations are kept; they keep working without T3 Fleet",
      );
      if (viaHub.length > 0)
        notes.push(
          `MCP: ${viaHub.map((h) => `${h.n} (${h.c})`).join(", ")} go through the fleet's hub at ${gateway}; they work only while the relay runs and accepts this machine's token`,
        );
      if (self.length === 0) return { step: null, notes };
      // T3 Fleet's own server cannot work once the machine has left.
      const lines = self
        .filter((s) => (s.c === "Claude" ? clients.claude : clients.codex))
        .map((s) =>
          s.c === "Claude"
            ? `$ claude mcp remove -s user ${sh(s.n)}`
            : `$ codex mcp remove ${sh(s.n)}`,
        );
      if (lines.length === 0) return { step: null, notes };
      return {
        step: {
          title: "Remove T3 Fleet's own MCP server from Claude and Codex",
          lines,
          apply: shell(lines.map((l) => l.slice(2)).join("\n"), home).pipe(
            Effect.as([`removed ${[...new Set(self.map((s) => s.n))].join(", ")}`]),
          ),
        } satisfies LeaveStep,
        notes,
      };
    }

    const before = {
      claude: snapshot.claude?.mcpServers ?? {},
      codex: snapshot.codex?.mcp_servers ?? {},
    };
    const commands: Array<string> = [];
    const appended: Array<{ name: string; entry: Json }> = [];
    const plan = (client: "claude" | "codex") => {
      const now = current[client];
      const was = before[client];
      const remove = Object.entries(now)
        .filter(([n, e]) => ours(n, e))
        .map(([n]) => n);
      // Put back what setup replaced or removed; a later entry of the user's own stays.
      const restore = Object.entries(was).filter(
        ([n, e]) =>
          (remove.includes(n) || now[n] === undefined) &&
          JSON.stringify(now[n]) !== JSON.stringify(e),
      );
      const removeFirst = remove.filter((n) => JSON.stringify(now[n]) !== JSON.stringify(was[n]));
      if (!clients[client]) {
        if (removeFirst.length > 0 || restore.length > 0)
          notes.push(
            `MCP: ${client === "claude" ? "Claude Code" : "Codex"} is not installed here, so its registrations are left as they are`,
          );
        return;
      }
      for (const n of removeFirst)
        commands.push(
          client === "claude" ? `claude mcp remove -s user ${sh(n)}` : `codex mcp remove ${sh(n)}`,
        );
      for (const [n, e] of restore) {
        if (client === "claude")
          commands.push(`claude mcp add-json -s user ${sh(n)} ${sh(JSON.stringify(e))}`);
        else appended.push({ name: n, entry: e });
      }
    };
    plan("claude");
    plan("codex");
    if (commands.length === 0 && appended.length === 0) return { step: null, notes };
    const codexFile = `${home}/.codex/config.toml`;
    return {
      step: {
        title: "Put back the MCP servers Claude and Codex had before setup",
        lines: [
          ...commands.map((c) => `$ ${c}`),
          ...appended.map(
            (a) => `~/.codex/config.toml  gets back [mcp_servers.${a.name}] as it was`,
          ),
        ],
        apply: Effect.gen(function* () {
          if (commands.length > 0) yield* shell(commands.join("\n"), home);
          if (appended.length > 0) {
            const text = yield* fs.readFileString(codexFile).pipe(Effect.orElseSucceed(() => ""));
            const tables = appended.map((a) => codexTable(a.name, a.entry)).join("\n");
            yield* fs
              .writeFileString(
                codexFile,
                `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${text === "" ? "" : "\n"}${tables}`,
              )
              .pipe(Effect.mapError((e) => `writing ${codexFile}: ${e.message}`));
          }
          return ["Claude's and Codex's MCP servers are back as they were before setup"];
        }),
      } satisfies LeaveStep,
      notes,
    };
  });

/** What setup moved aside goes back where it was. */
const movedStep = (home: string, snapshot: SetupSnapshot | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const notes: Array<string> = [];
    const back: Array<{ path: string; backup: string }> = [];
    for (const m of snapshot?.moved ?? []) {
      const at = expandHome(m.path, home);
      const backup = expandHome(m.backup, home);
      if (!(yield* fs.exists(backup).pipe(Effect.orElseSucceed(() => false)))) {
        notes.push(`${tilde(at, home)}: setup moved it to ${tilde(backup, home)}, which is gone`);
        continue;
      }
      const isLink = Option.isSome(yield* fs.readLink(at).pipe(Effect.option));
      if (!isLink && (yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)))) {
        notes.push(
          `${tilde(at, home)} is a real file or directory again, so setup's backup stays at ${tilde(backup, home)}`,
        );
        continue;
      }
      back.push({ path: at, backup });
    }
    if (back.length === 0) return { step: null, notes };
    return {
      step: {
        title: "Put back what setup moved aside",
        lines: back.map(
          (b) => `$ mv ${shPath(tilde(b.backup, home))} ${shPath(tilde(b.path, home))}`,
        ),
        apply: Effect.forEach(back, (b) =>
          Effect.gen(function* () {
            yield* fs.remove(b.path, { force: true });
            yield* fs.makeDirectory(path.dirname(b.path), { recursive: true });
            yield* fs.rename(b.backup, b.path);
          }).pipe(Effect.mapError((e) => `putting back ${tilde(b.path, home)}: ${e.message}`)),
        ).pipe(Effect.as([`put back ${back.length} item${back.length === 1 ? "" : "s"}`])),
      } satisfies LeaveStep,
      notes,
    };
  });

// ---- the fleet --------------------------------------------------------------

/**
 * The fleet's secrets as this machine reads them, or null when it has no key
 * or cannot read them. Never creates a key: planning only reads.
 */
const secretsIfReadable = (repo: string, home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const key = (yield* fs.readFileString(keyPath(home)).pipe(Effect.orElseSucceed(() => "")))
      .split("\n")
      .find((l) => l.startsWith("AGE-SECRET-KEY-"));
    if (key === undefined) return null;
    const armored = yield* fs.readFileString(encryptedPath(repo)).pipe(Effect.option);
    if (Option.isNone(armored)) return "";
    return Option.getOrNull(yield* decryptWith(key, armored.value).pipe(Effect.option));
  });

const RECIPIENTS_HEADER = "# Public age keys of the nodes that can read secrets.env.age.\n";

/**
 * Proposes the removal on t3-fleet/staging/<node>: one commit on origin's
 * branch, built in a scratch index so the checkout is untouched, that deletes
 * nodes/<node>.toml and drops the node's recipient (re-encrypting the
 * secrets when this machine can read them).
 */
const proposeRemoval = (config: Config, node: string, home: string) =>
  Effect.gen(function* () {
    const repo = config.repo;
    const fetch = yield* git(repo, ["fetch", "-q", "origin", config.branch]);
    if (!ok(fetch)) return yield* Effect.fail(`fetching ${config.branch}: ${why(fetch)}`);
    const base = `origin/${config.branch}`;
    const env = { GIT_INDEX_FILE: `${repo}/.git/t3-fleet-leave-index`, ...literal };
    const read = yield* git(repo, ["read-tree", base], { env });
    if (!ok(read)) return yield* Effect.fail(`proposing: ${why(read)}`);
    const files = [`nodes/${node}.toml`];
    yield* git(repo, ["rm", "-q", "--cached", "--ignore-unmatch", "--", files[0] ?? ""], { env });
    const show = (file: string) =>
      git(repo, ["show", `${base}:${file}`]).pipe(Effect.map((r) => (ok(r) ? r.stdout : null)));
    const put = (file: string, text: string) =>
      Effect.gen(function* () {
        const blob = yield* git(repo, ["hash-object", "-w", "--stdin"], { stdin: text });
        if (!ok(blob)) return yield* Effect.fail(`proposing: ${why(blob)}`);
        yield* git(repo, ["update-index", "--add", "--cacheinfo", `100644,${out(blob)},${file}`], {
          env,
        });
        files.push(file);
      });
    const recipientsText = yield* show("secrets/recipients.toml");
    if (recipientsText !== null) {
      const recipients = yield* Effect.try(() => parseToml(recipientsText) as Json).pipe(
        Effect.orElseSucceed(() => ({}) as Json),
      );
      if (node in recipients) {
        const rest = Object.fromEntries(
          Object.entries(recipients)
            .filter(([k, v]) => k !== node && typeof v === "string")
            .sort(([a], [b]) => a.localeCompare(b)),
        ) as Record<string, string>;
        yield* put("secrets/recipients.toml", `${RECIPIENTS_HEADER}${stringifyToml(rest)}\n`);
        // Re-encrypted from origin's copy, which may be newer than the checkout's.
        const armored = yield* show("secrets/secrets.env.age");
        const key = (yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.readFileString(keyPath(home))),
          Effect.orElseSucceed(() => ""),
        ))
          .split("\n")
          .find((l) => l.startsWith("AGE-SECRET-KEY-"));
        if (armored !== null && key !== undefined && Object.keys(rest).length > 0) {
          const plain = yield* decryptWith(key, armored).pipe(Effect.option);
          if (Option.isSome(plain)) {
            const sealed = yield* encryptFor(Object.values(rest), plain.value).pipe(
              Effect.mapError((e) => e.message),
            );
            yield* put("secrets/secrets.env.age", sealed);
          }
        }
      }
    }
    const tree = out(yield* git(repo, ["write-tree"], { env }));
    const commit = yield* git(repo, [
      "commit-tree",
      tree,
      "-p",
      base,
      "-m",
      `Proposed by ${node}: remove ${node} from the fleet\n\n${files.join("\n")}`,
    ]);
    if (!ok(commit)) return yield* Effect.fail(`proposing: ${why(commit)}`);
    const ref = `refs/heads/${branchPrefix("staging")}${node}`;
    const push = yield* git(repo, ["push", "-q", "--force", "origin", `${out(commit)}:${ref}`]);
    if (!ok(push)) return yield* Effect.fail(`proposing: ${why(push)}`);
    return out(commit).slice(0, 7);
  });

/** An authority removes the node itself, through the locked paths every repo change takes. */
const commitRemoval = (config: Config, node: string, home: string) =>
  underSyncLock(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repo = config.repo;
      const recipients = yield* readRecipients(repo).pipe(Effect.mapError((e) => e.message));
      const paths = [`nodes/${node}.toml`];
      if (node in recipients) {
        const plaintext = yield* secretsIfReadable(repo, home);
        const { [node]: _gone, ...rest } = recipients;
        yield* writeRecipients(repo, rest).pipe(Effect.mapError(message));
        paths.push(recipientsPath(repo).slice(repo.length + 1));
        // Unreadable secrets stay as they are: a later `secrets set` encrypts for the new recipients.
        if (plaintext !== null && plaintext !== "") {
          yield* writeSecrets(repo, plaintext).pipe(Effect.mapError(message));
          paths.push(encryptedPath(repo).slice(repo.length + 1));
        }
      }
      yield* fs
        .remove(`${repo}/nodes/${node}.toml`, { force: true })
        .pipe(Effect.mapError((e) => e.message));
      const rev = yield* commitAndPush(repo, paths, `Remove ${node} from the fleet`);
      // Its published state and any proposal go too; nothing else reads them now.
      for (const kind of ["state", "staging", "rejected"] as const)
        yield* git(repo, ["push", "-q", "origin", `:refs/heads/${branchPrefix(kind)}${node}`]);
      return rev;
    }),
  );

const fleetStep = (config: Config, home: string) =>
  Effect.gen(function* () {
    const node = config.self;
    const self = config.nodes.find((n) => n.name === node);
    if (self === undefined)
      return {
        step: null,
        refusal: null,
        notes: [`${node} is no longer in the config repo; nothing to remove there`],
      };
    const notes: Array<string> = [];
    if (self.roles.includes("relay"))
      notes.push(
        `${node} runs the fleet's relay: until another machine takes the relay role (and [relay] url points at it), the others lose the relay, its listeners and the MCP hub`,
      );
    const secrets = yield* secretsIfReadable(config.repo, home);
    const own =
      secrets !== null
        ? varNames(secrets).filter((v) =>
            v.endsWith(`_${node.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`),
          )
        : [];
    if (own.length > 0)
      notes.push(
        `secrets named for ${node} stay in the fleet (${own.join(", ")}); revoke them on an authority (t3-fleet mcp token revoke, t3-fleet secrets unset)`,
      );
    if (self.roles.includes("authority")) {
      const others = config.nodes.filter((n) => n.name !== node && n.roles.includes("authority"));
      if (others.length === 0)
        return {
          step: null,
          refusal: `${node} is the fleet's only authority; give another machine the authority role (roles = ["authority"] in its nodes/<name>.toml) first, or the fleet would have no one to approve changes`,
          notes,
        };
      return {
        step: {
          title: `Remove ${node} from the fleet (commit and push, as an authority)`,
          lines: [
            `git rm nodes/${node}.toml`,
            `drop ${node} from secrets/recipients.toml and re-encrypt secrets/secrets.env.age for the others`,
            `commit "Remove ${node} from the fleet" and push to ${config.branch}`,
            `delete ${["state", "staging", "rejected"].map((k) => `${branchPrefix(k as "state")}${node}`).join(", ")}`,
          ],
          apply: commitRemoval(config, node, home).pipe(
            Effect.mapError(message),
            Effect.map((rev) => [`${node} is out of the fleet (${rev})`]),
          ),
        } satisfies LeaveStep,
        refusal: null,
        notes,
      };
    }
    return {
      step: {
        title: `Propose removing ${node} from the fleet (members cannot push to ${config.branch})`,
        lines: [
          `propose on ${branchPrefix("staging")}${node}: delete nodes/${node}.toml, drop ${node} from secrets/recipients.toml (and re-encrypt the secrets for the others)`,
          `an authority must approve it: t3-fleet review, then t3-fleet approve ${node} <commit>`,
        ],
        apply: proposeRemoval(config, node, home).pipe(
          Effect.mapError((e) => (typeof e === "string" ? e : String(e))),
          Effect.map((commit) => [
            `proposed ${commit}; on an authority run: t3-fleet approve ${node} ${commit}`,
          ]),
        ),
      } satisfies LeaveStep,
      refusal: null,
      notes,
    };
  });

// ---- local state -----------------------------------------------------------

const SKILL_BACKUPS = "skill-backups";

const purgeStep = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    const notes: Array<string> = [];
    const remove: Array<string> = [];
    if (yield* exists(configDir(home))) remove.push(configDir(home));
    const state = stateDir(home);
    // Skills this machine had before it joined are the user's own: they stay.
    const keep = (yield* exists(`${state}/${SKILL_BACKUPS}`)) ? SKILL_BACKUPS : null;
    const stateEntries = (yield* fs
      .readDirectory(state)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter((e) => e !== keep)
      .map((e) => `${state}/${e}`);
    if (keep !== null)
      notes.push(
        `kept ${tilde(`${state}/${SKILL_BACKUPS}`, home)}: the skills this machine had before it joined`,
      );
    const share = `${home}/${SHARE_DIR}`;
    if (yield* exists(share)) remove.push(share);
    const command = `${home}/.local/bin/${CLI}`;
    const isCommand =
      Option.isSome(yield* fs.readLink(command).pipe(Effect.option)) || (yield* exists(command));
    if (isCommand) remove.push(command);
    else
      notes.push(
        `${CLI} was not installed by its installer here (Homebrew or Nix?); uninstall it there`,
      );
    const all = [...remove, ...stateEntries];
    if (keep === null && (yield* exists(state))) all.push(state);
    if (all.length === 0) return { step: null, notes };
    return {
      step: {
        title:
          "Remove T3 Fleet's local state: this machine's key, the decrypted secrets, logs and the installed bundle",
        lines: all.map((p) => `$ rm -rf ${shPath(tilde(p, home))}`),
        apply: Effect.forEach(all, (p) =>
          fs
            .remove(p, { recursive: true, force: true })
            .pipe(Effect.mapError((e) => `removing ${tilde(p, home)}: ${e.message}`)),
        ).pipe(Effect.as([`removed ${all.length} path${all.length === 1 ? "" : "s"}`])),
      } satisfies LeaveStep,
      notes,
    };
  });

// ---- the plan ---------------------------------------------------------------

/** What leaving does on this machine. Reads only. */
export const planLeave = (config: Config, options: LeaveOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = options.home;
    const platform = options.platform ?? process.platform;
    const root = options.root ?? process.getuid?.() === 0;
    const table = (config.nodes.find((n) => n.name === config.self)?.settings.table ?? {}) as Json;
    const snapshotText = yield* fs.readFileString(setupSnapshotPath(home)).pipe(Effect.option);
    const snapshot = Option.isSome(snapshotText)
      ? Option.getOrNull(decodeSnapshot(snapshotText.value))
      : null;
    const notes: Array<string> = [];
    if (Option.isSome(snapshotText) && snapshot === null)
      notes.push(`${tilde(setupSnapshotPath(home), home)} is not a setup snapshot; ignored`);

    const fleet = yield* fleetStep(config, home);
    notes.push(...fleet.notes);
    if (fleet.refusal !== null)
      return {
        node: config.self,
        repo: config.repo,
        refusal: fleet.refusal,
        steps: [],
        notes,
      } satisfies LeavePlan;

    const moved = yield* movedStep(home, snapshot);
    const skip = new Set((snapshot?.moved ?? []).map((m) => expandHome(m.path, home)));
    const mcp = yield* mcpStep(home, table, snapshot);
    const purge = options.purge ? yield* purgeStep(home) : null;
    notes.push(...moved.notes, ...mcp.notes, ...(purge?.notes ?? []));

    // Dotfile backups from joining: the person's own file from before.
    const backups: Array<string> = [];
    for (const area of ["dotfiles", "instructions"]) {
      const entries = Array.isArray(table[area]) ? table[area] : [];
      for (const e of entries) {
        if (!isObject(e) || typeof e["dest"] !== "string") continue;
        const dest = expandHome(e["dest"], home);
        const dir = dest.slice(0, dest.lastIndexOf("/"));
        const base = dest.slice(dest.lastIndexOf("/") + 1);
        for (const f of yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
          if (f.startsWith(`${base}.t3-fleet-backup.`)) backups.push(tilde(`${dir}/${f}`, home));
      }
    }
    if (backups.length > 0)
      notes.push(
        `your files from before joining are still beside them: ${backups.sort().join(", ")}`,
      );

    if (!options.purge)
      notes.push(
        `kept ${tilde(configDir(home), home)} (this machine's key and the decrypted secrets.env), ${tilde(stateDir(home), home)} and the installed ${CLI}; --purge removes them`,
      );
    notes.push(
      `the config repo checkout stays at ${tilde(config.repo, home)}; delete it yourself once you no longer need it`,
    );

    const steps: Array<LeaveStep> = [
      fleet.step,
      yield* servicesStep(home, platform, root),
      yield* linksStep(config, home, table, skip),
      moved.step,
      yield* modelsStep(home),
      mcp.step,
      purge?.step ?? null,
    ].filter((s) => s !== null);
    return {
      node: config.self,
      repo: config.repo,
      refusal: null,
      steps,
      notes,
    } satisfies LeavePlan;
  });

export interface LeaveOutcome {
  readonly title: string;
  readonly ok: boolean;
  readonly lines: ReadonlyArray<string>;
}

/**
 * Runs the plan's steps in order and stops at the first that fails: leaving
 * the fleet comes first, so a removal that cannot be committed or proposed
 * changes nothing on the machine.
 */
export const applyLeave = (plan: LeavePlan) =>
  Effect.gen(function* () {
    const outcomes: Array<LeaveOutcome> = [];
    for (const step of plan.steps) {
      const result = yield* step.apply.pipe(Effect.result);
      if (result._tag === "Success") {
        outcomes.push({ title: step.title, ok: true, lines: result.success });
      } else {
        outcomes.push({ title: step.title, ok: false, lines: [result.failure] });
        break;
      }
    }
    return outcomes;
  });
