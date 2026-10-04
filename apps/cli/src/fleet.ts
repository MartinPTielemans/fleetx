/**
 * Commands that work through the config repo rather than ssh: sync, the
 * proposal workflow, the fleet's published state, alerts, skill adoption.
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { expandHome, loadConfig, type Config } from "@t3-fleet/core/Config";
import type { Finding } from "@t3-fleet/core/Diagnose";
import { exec } from "@t3-fleet/core/Exec";
import { lookupLatest } from "@t3-fleet/core/Latest";
import type { NodeResult } from "@t3-fleet/core/Remote";
import { renderStatus } from "@t3-fleet/core/Render";
import { addSkills, land, removeSkills, updateSkills } from "@t3-fleet/core/SkillSources";
import { renameRepo } from "@t3-fleet/core/RepoRename";
import { approve, listProposals, reject } from "@t3-fleet/core/Staging";
import { readStates, syncRun, type Alert, type NodeState } from "@t3-fleet/core/Sync";

import { reportUserErrors } from "./shared.ts";
import { stateDir } from "@t3-fleet/core/Names";

export const syncCommand = Command.make("sync", {
  noApply: Flag.Boolean("no-apply").pipe(Flag.withDescription("Report only; run no fixes."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Propose, pull, converge this machine, publish its state. What the timer runs."),
  Command.withHandler(({ noApply }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const result = yield* syncRun(config, { apply: !noApply });
      for (const line of result.lines) yield* Console.log(line);
      if (result.state !== null) {
        yield* Console.log(`${result.state.result === "ok" ? "synced" : "sync incomplete"} at ${result.state.rev}: ${result.state.message}`);
        if (result.state.result !== "ok") process.exitCode = 1;
      }
    }).pipe(reportUserErrors),
  ),
);

/** The fleet as its nodes last reported it, without contacting any of them. */
export const fleetFromStates = (config: Config) =>
  Effect.gen(function* () {
    const states = yield* readStates(config.repo);
    const now = yield* Clock.currentTimeMillis;
    const results: Array<NodeResult> = [];
    const findings: Array<Finding> = [];
    for (const node of config.nodes) {
      const state = states.find((s) => s.node === node.name);
      if (state === undefined || state.observation === null) {
        results.push({ node, ok: false, error: "has not published any state yet (no t3-fleet sync has run there)", ms: 0 });
        continue;
      }
      results.push({
        node,
        ok: true,
        observation: { ...state.observation, lastSync: { when: Math.round(state.at / 1000), result: state.result, message: state.message, streak: state.streak } },
        ms: 0,
      });
      findings.push(...(state.findings as ReadonlyArray<Finding>));
      const ageSeconds = (now - state.at) / 1000;
      if (ageSeconds > config.interval * config.alertAfter) {
        findings.push({ node: node.name, key: "state-stale", severity: "error", area: "sync", title: `last reported ${Math.round(ageSeconds / 60)} minutes ago; is its timer running?` });
      }
    }
    return { states, results, findings };
  });

export const renderFleetFromStates = (config: Config, verbose: boolean) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const { results, findings } = yield* fleetFromStates(config);
    const latest = yield* lookupLatest(
      results.flatMap((r) => (r.ok ? [r.observation.t3.descriptor?.serverVersion ?? r.observation.t3.installedVersion ?? ""] : [])).filter(Boolean),
    );
    const order = { error: 0, warn: 1, info: 2 } as const;
    const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.node.localeCompare(b.node));
    return renderStatus(results, sorted, latest, { verbose, elapsedMs: (yield* Clock.currentTimeMillis) - started });
  });

const asAuthority = Effect.gen(function* () {
  const config = yield* loadConfig;
  if (!config.nodes.find((n) => n.name === config.self)?.roles.includes("authority")) {
    return yield* Effect.fail(`${config.self} is not an authority; run this on a node with the authority role`);
  }
  return config;
});

export const reviewCommand = Command.make("review").pipe(
  Command.withDescription("List proposals waiting for approval."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const proposals = yield* listProposals(config.repo, config.branch);
      if (proposals.length === 0) {
        yield* Console.log("no proposals waiting");
        return;
      }
      for (const p of proposals) {
        yield* Console.log(`${p.node}  (${p.commit.slice(0, 7)})\n${p.stat.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
      }
      yield* Console.log("t3-fleet approve <node>   or   t3-fleet reject <node>");
    }).pipe(reportUserErrors),
  ),
);

const proposalOf = (config: Config, node: string) =>
  Effect.gen(function* () {
    const proposal = (yield* listProposals(config.repo, config.branch)).find((p) => p.node === node);
    if (proposal === undefined) return yield* Effect.fail(`no proposal from ${node}`);
    return proposal;
  });

const repoRenameCommand = Command.make("rename").pipe(
  Command.withDescription("Move the config repo to T3 Fleet's names: t3-fleet.toml, t3-fleet/ branches, T3_FLEET_ secrets (authority)."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      const done = yield* renameRepo(config.repo, config.branch);
      yield* Console.log(done.length === 0 ? "the config repo already has T3 Fleet's names" : done.join("\n"));
    }).pipe(reportUserErrors),
  ),
);

export const repoCommand = Command.make("repo").pipe(
  Command.withDescription("The config repo itself."),
  Command.withSubcommands([repoRenameCommand]),
);

export const approveCommand = Command.make("approve", { node: Argument.String("node") }).pipe(
  Command.withDescription("Apply a node's proposal to the branch (authority)."),
  Command.withHandler(({ node }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      const rev = yield* approve(config.repo, config.branch, yield* proposalOf(config, node), config.self);
      yield* Console.log(`approved ${node}'s proposal (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

export const rejectCommand = Command.make("reject", { node: Argument.String("node") }).pipe(
  Command.withDescription("Decline a node's proposal; that node sets its edits aside on its next sync (authority)."),
  Command.withHandler(({ node }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      yield* reject(config.repo, yield* proposalOf(config, node));
      yield* Console.log(`rejected ${node}'s proposal`);
    }).pipe(reportUserErrors),
  ),
);

const seenPath = (home: string) => `${stateDir(home)}/alerts-seen`;

/** Alerts every node published since the last call; marks them seen. */
export const takeAlerts = (config: Config, peek = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    const seen = Number(Option.getOrElse(yield* fs.readFileString(seenPath(home)).pipe(Effect.option), () => "0").trim()) || 0;
    const { states, findings } = yield* fleetFromStates(config);
    const alerts: Array<Alert> = states.flatMap((s: NodeState) => s.alerts).filter((a) => a.at > seen);
    // A node that stopped reporting cannot publish an alert about itself.
    for (const f of findings.filter((x) => x.key === "state-stale")) alerts.push({ at: yield* Clock.currentTimeMillis, node: f.node, kind: "failing", message: f.title });
    alerts.sort((a, b) => a.at - b.at);
    const newest = Math.max(seen, ...states.flatMap((s) => s.alerts.map((a) => a.at)));
    if (!peek) {
      yield* fs.makeDirectory(stateDir(home), { recursive: true }).pipe(Effect.ignore);
      yield* fs.writeFileString(seenPath(home), String(newest));
    }
    return alerts;
  });

export const alertsCommand = Command.make("alerts").pipe(
  Command.withDescription("Print health changes every machine reported since the last call."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const alerts = yield* takeAlerts(yield* loadConfig);
      if (alerts.length === 0) yield* Console.log("no new alerts");
      for (const a of alerts) yield* Console.log(`${a.kind.padEnd(9)} ${a.node.padEnd(10)} ${a.message}`);
    }).pipe(reportUserErrors),
  ),
);

const adopt = Command.make("adopt", {
  name: Argument.String("skill"),
  from: Flag.String("from").pipe(Flag.withDescription("Directory the skill was installed into.")),
}).pipe(
  Command.withDescription("Move a skill installed outside T3 Fleet into the config repo; sync proposes or commits it."),
  Command.withHandler(({ name, from }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* loadConfig;
      const home = process.env["HOME"] ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return yield* Effect.fail(`not a skill name: ${name}`);
      const src = path.join(expandHome(from, home), name);
      const dest = path.join(config.repo, "skills", name);
      if (!(yield* fs.exists(path.join(src, "SKILL.md")).pipe(Effect.orElseSucceed(() => false)))) return yield* Effect.fail(`${src} has no SKILL.md`);
      if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) return yield* Effect.fail(`skills/${name} already exists in the repo`);
      const copy = yield* exec({ command: "cp", args: ["-R", src, dest], timeout: Duration.seconds(30) });
      if (copy.code !== 0) return yield* Effect.fail(`copying: ${copy.stderr.trim()}`);
      const aside = path.join(stateDir(home), "adopted", String(yield* Clock.currentTimeMillis));
      yield* fs.makeDirectory(aside, { recursive: true });
      yield* fs.rename(src, path.join(aside, name));
      yield* Console.log(`skills/${name} is in the repo; the original is in ${aside}. The next sync links it and ${config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") ? "commits" : "proposes"} it.`);
    }).pipe(reportUserErrors),
  ),
);

const add = Command.make("add", {
  source: Argument.String("source").pipe(Argument.withDescription("owner/repo or a git URL")),
  skills: Argument.String("skill").pipe(Argument.variadic()),
  as: Flag.String("as").pipe(Flag.withDescription("Vendor the one skill under another name (on a clash)."), Flag.optional),
}).pipe(
  Command.withDescription("Vendor skills from a git repository into the config repo, with provenance."),
  Command.withHandler(({ source, skills, as }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const paths = yield* addSkills(config.repo, source, skills, as._tag === "Some" ? as.value : undefined);
      const names = paths.filter((p) => p !== "skills/SOURCES.json").map((p) => p.slice("skills/".length));
      yield* Console.log(`added ${names.join(", ")}: ${yield* land(config, paths, `Add skill${names.length === 1 ? "" : "s"} ${names.join(", ")} from ${source}`)}`);
    }).pipe(reportUserErrors),
  ),
);

const update = Command.make("update", {
  skills: Argument.String("skill").pipe(Argument.variadic()),
  yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDescription("Keep the changes without asking."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Re-pull vendored skills from where they came from; shows what changed and asks."),
  Command.withHandler(({ skills, yes }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const touched = yield* updateSkills(config.repo, skills);
      const stat = yield* exec({ command: "git", args: ["-C", config.repo, "diff", "--stat", "--", ...touched], timeout: Duration.seconds(10) });
      const changed = yield* exec({ command: "git", args: ["-C", config.repo, "status", "--porcelain", "--", ...touched], timeout: Duration.seconds(10) });
      if (changed.stdout.trim() === "") {
        yield* Console.log("every skill is current");
        return;
      }
      yield* Console.log(stat.stdout.trim() || changed.stdout.trim());
      const keep =
        yes || (process.stdin.isTTY === true && (yield* Prompt.run(Prompt.Confirm({ message: "Keep these changes?" })).pipe(Effect.orElseSucceed(() => false))));
      if (!keep) {
        yield* exec({ command: "git", args: ["-C", config.repo, "checkout", "--", ...touched], timeout: Duration.seconds(10) });
        yield* exec({ command: "git", args: ["-C", config.repo, "clean", "-qfd", "--", ...touched], timeout: Duration.seconds(10) });
        yield* Console.log(process.stdin.isTTY === true ? "discarded" : "discarded; re-run with --yes to keep them");
        return;
      }
      yield* Console.log(yield* land(config, touched, `Update skill${touched.length === 1 ? "" : "s"} from upstream`));
    }).pipe(reportUserErrors),
  ),
);

const remove = Command.make("remove", { skills: Argument.String("skill").pipe(Argument.variadic({ min: 1 })) }).pipe(
  Command.withDescription("Drop vendored skills; every node unlinks them on its next sync."),
  Command.withHandler(({ skills }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const paths = yield* removeSkills(config.repo, skills);
      yield* Console.log(`removed ${skills.join(", ")}: ${yield* land(config, paths, `Remove skill${skills.length === 1 ? "" : "s"} ${skills.join(", ")}`)}`);
    }).pipe(reportUserErrors),
  ),
);

export const skillsCommand = Command.make("skills").pipe(
  Command.withDescription("Skills vendored in the config repo."),
  Command.withSubcommands([add, update, remove, adopt]),
);

/** Definitions are files people read and edit. */
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Add `name` to a node file's MCP servers: into an existing `servers` or
 * `"servers.add"` list under [mcp], or as a new `"servers.add"` entry.
 */
export const withMcpServer = (text: string, name: string) => {
  const table = /^\[mcp\][ \t]*$/m.exec(text);
  if (table !== null) {
    const rest = text.slice(table.index);
    const end = rest.slice(1).search(/^\[/m);
    const body = end === -1 ? rest : rest.slice(0, end + 1);
    const list = /^("servers\.add"|servers)[ \t]*=[ \t]*\[(.*)\][ \t]*$/m.exec(body);
    const updated = list
      ? body.replace(list[0], `${list[1]} = [${[list[2]?.trim(), JSON.stringify(name)].filter(Boolean).join(", ")}]`)
      : body.replace(/^\[mcp\][ \t]*$/m, `[mcp]\n"servers.add" = [${JSON.stringify(name)}]`);
    return text.slice(0, table.index) + updated + rest.slice(body.length);
  }
  return `${text.trimEnd()}\n\n[mcp]\n"servers.add" = [${JSON.stringify(name)}]\n`;
};

/** Declare an MCP server once; nodes listing it register it on their next sync. */
export const mcpAddCommand = Command.make("add", {
  name: Argument.String("name"),
  url: Flag.String("url").pipe(Flag.withDescription("A server reached directly over HTTP."), Flag.optional),
  command: Flag.String("command").pipe(Flag.withDescription("A stdio server: the command to run (use ~ for home)."), Flag.optional),
  arg: Flag.String("arg").pipe(Flag.withDescription("An argument for --command (repeatable)."), Flag.atLeast(0)),
  token: Flag.String("token-env").pipe(Flag.withDescription("Send this secret as a bearer token (set it with t3-fleet secrets set)."), Flag.optional),
  node: Flag.String("node").pipe(Flag.withDescription("Register on this node (repeatable); default every node."), Flag.atLeast(0)),
}).pipe(
  Command.withDescription("Declare an MCP server in mcp/<name>.json and register it on nodes."),
  Command.withHandler(({ name, url, command, arg, token, node }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* loadConfig;
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return yield* Effect.fail("names are lowercase letters, digits, - and _");
      if ((url._tag === "Some") === (command._tag === "Some")) return yield* Effect.fail("give exactly one of --url or --command");
      const definition =
        url._tag === "Some"
          ? { kind: "direct", url: url.value, ...(token._tag === "Some" ? { auth: { type: "bearer", token_env: token.value } } : {}) }
          : { kind: "stdio", command: command._tag === "Some" ? command.value : "", args: arg };
      yield* fs.writeFileString(`${config.repo}/mcp/${name}.json`, prettyJson(definition));
      const targets = node.length > 0 ? node : config.nodes.map((n) => n.name);
      const changed = [`mcp/${name}.json`];
      for (const target of targets) {
        const file = `${config.repo}/nodes/${target}.toml`;
        const text = yield* fs.readFileString(file).pipe(Effect.mapError(() => `unknown machine: ${target}`));
        if (text.includes(`"${name}"`)) continue;
        yield* fs.writeFileString(file, withMcpServer(text, name));
        changed.push(`nodes/${target}.toml`);
      }
      yield* Console.log(`declared ${name} for ${targets.join(", ")}: ${yield* land(config, changed, `Add MCP server ${name}`)}`);
    }).pipe(reportUserErrors),
  ),
);
