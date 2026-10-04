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
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { expandHome, loadConfig, loadConfigFrom, type Config } from "@t3-fleet/core/Config";
import type { Finding } from "@t3-fleet/core/Diagnose";
import { exec } from "@t3-fleet/core/Exec";
import { indexEntries, restorePaths, snapshot, unmergedHits } from "@t3-fleet/core/Git";
import { lookupLatest } from "@t3-fleet/core/Latest";
import type { NodeResult } from "@t3-fleet/core/Remote";
import { renderStatus } from "@t3-fleet/core/Render";
import {
  addSkills,
  keepUpdate,
  land,
  previewUpdate,
  removeSkills,
} from "@t3-fleet/core/SkillSources";
import {
  Endpoint,
  endpointProblem,
  parseSecrets,
  registerInClaude,
  secretRef,
} from "@t3-fleet/core/areas/Mcp";
import { NAME_PATTERN } from "@t3-fleet/core/hub/Definitions";
import { isSkillBackup } from "@t3-fleet/core/areas/Skills";
import {
  encryptedPath,
  installSecrets,
  localSecretsPath,
  readSecrets,
  setVar,
  writeSecrets,
} from "@t3-fleet/core/Secrets";
import { approve, listProposals, reject } from "@t3-fleet/core/Staging";
import {
  readStates,
  syncRun,
  underSyncLock,
  type Alert,
  type NodeState,
} from "@t3-fleet/core/Sync";

import { reportUserErrors } from "./shared.ts";
import { FLEET_FILE, stateDir } from "@t3-fleet/core/Names";

export const syncCommand = Command.make("sync", {
  noApply: Flag.Boolean("no-apply").pipe(
    Flag.withDescription("Report only; run no fixes."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Propose, pull, converge this machine, publish its state. What the timer runs.",
  ),
  Command.withHandler(({ noApply }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const result = yield* syncRun(config, { apply: !noApply });
      for (const line of result.lines) yield* Console.log(line);
      if (result.state !== null) {
        yield* Console.log(
          `${result.state.result === "ok" ? "synced" : "sync incomplete"} at ${result.state.rev}: ${result.state.message}`,
        );
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
        results.push({
          node,
          ok: false,
          error: "has not published any state yet (no t3-fleet sync has run there)",
          ms: 0,
        });
        continue;
      }
      results.push({
        node,
        ok: true,
        observation: {
          ...state.observation,
          lastSync: {
            when: Math.round(state.at / 1000),
            result: state.result,
            message: state.message,
            streak: state.streak,
          },
        },
        ms: 0,
      });
      findings.push(...(state.findings as ReadonlyArray<Finding>));
      const ageSeconds = (now - state.at) / 1000;
      if (ageSeconds > config.interval * config.alertAfter) {
        findings.push({
          node: node.name,
          key: "state-stale",
          severity: "error",
          area: "sync",
          title: `last reported ${Math.round(ageSeconds / 60)} minutes ago; is its timer running?`,
        });
      }
    }
    return { states, results, findings };
  });

export const renderFleetFromStates = (config: Config, verbose: boolean) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const { results, findings } = yield* fleetFromStates(config);
    const latest = yield* lookupLatest(
      results
        .flatMap((r) =>
          r.ok
            ? [
                r.observation.t3.descriptor?.serverVersion ??
                  r.observation.t3.installedVersion ??
                  "",
              ]
            : [],
        )
        .filter(Boolean),
    );
    const order = { error: 0, warn: 1, info: 2 } as const;
    const sorted = [...findings].sort(
      (a, b) => order[a.severity] - order[b.severity] || a.node.localeCompare(b.node),
    );
    return renderStatus(results, sorted, latest, {
      verbose,
      elapsedMs: (yield* Clock.currentTimeMillis) - started,
    });
  });

const asAuthority = Effect.gen(function* () {
  const config = yield* loadConfig;
  if (!config.nodes.find((n) => n.name === config.self)?.roles.includes("authority")) {
    return yield* Effect.fail(
      `${config.self} is not an authority; run this on a node with the authority role`,
    );
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
        yield* Console.log(
          `${p.node}  (${p.commit.slice(0, 7)})\n${p.stat
            .split("\n")
            .map((l) => `  ${l}`)
            .join("\n")}\n`,
        );
      }
      yield* Console.log("t3-fleet approve <node> <commit>   or   t3-fleet reject <node> <commit>");
    }).pipe(reportUserErrors),
  ),
);

const proposalOf = (config: Config, node: string) =>
  Effect.gen(function* () {
    const proposal = (yield* listProposals(config.repo, config.branch)).find(
      (p) => p.node === node,
    );
    if (proposal === undefined) return yield* Effect.fail(`no proposal from ${node}`);
    return proposal;
  });

/** The commit `t3-fleet review` showed; the command refuses when the proposal moved on since. */
const reviewedArg = Argument.String("commit").pipe(
  Argument.withDescription("The commit review showed."),
  Argument.optional,
);

export const approveCommand = Command.make("approve", {
  node: Argument.String("node"),
  commit: reviewedArg,
}).pipe(
  Command.withDescription("Apply a node's proposal to the branch (authority)."),
  Command.withHandler(({ node, commit }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      const rev = yield* approve(
        config.repo,
        config.branch,
        yield* proposalOf(config, node),
        config.self,
        Option.getOrUndefined(commit),
      );
      yield* Console.log(`approved ${node}'s proposal (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

export const rejectCommand = Command.make("reject", {
  node: Argument.String("node"),
  commit: reviewedArg,
}).pipe(
  Command.withDescription(
    "Decline a node's proposal; that node sets its edits aside on its next sync (authority).",
  ),
  Command.withHandler(({ node, commit }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      yield* reject(config.repo, yield* proposalOf(config, node), Option.getOrUndefined(commit));
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
    const seen =
      Number(
        Option.getOrElse(
          yield* fs.readFileString(seenPath(home)).pipe(Effect.option),
          () => "0",
        ).trim(),
      ) || 0;
    const { states, findings } = yield* fleetFromStates(config);
    const alerts: Array<Alert> = states
      .flatMap((s: NodeState) => s.alerts)
      .filter((a) => a.at > seen);
    // A node that stopped reporting cannot publish an alert about itself.
    for (const f of findings.filter((x) => x.key === "state-stale"))
      alerts.push({
        at: yield* Clock.currentTimeMillis,
        node: f.node,
        kind: "failing",
        message: f.title,
      });
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
      for (const a of alerts)
        yield* Console.log(`${a.kind.padEnd(9)} ${a.node.padEnd(10)} ${a.message}`);
    }).pipe(reportUserErrors),
  ),
);

const adopt = Command.make("adopt", {
  name: Argument.String("skill"),
  from: Flag.String("from").pipe(Flag.withDescription("Directory the skill was installed into.")),
}).pipe(
  Command.withDescription(
    "Move a skill installed outside T3 Fleet into the config repo; sync proposes or commits it.",
  ),
  Command.withHandler(({ name, from }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* loadConfig;
      const home = process.env["HOME"] ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || isSkillBackup(name))
        return yield* Effect.fail(`not a skill name: ${name}`);
      const src = path.join(expandHome(from, home), name);
      const dest = path.join(config.repo, "skills", name);
      if (!(yield* fs.exists(path.join(src, "SKILL.md")).pipe(Effect.orElseSucceed(() => false))))
        return yield* Effect.fail(`${src} has no SKILL.md`);
      if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false)))
        return yield* Effect.fail(`skills/${name} already exists in the repo`);
      const copy = yield* underSyncLock(
        exec({ command: "cp", args: ["-R", src, dest], timeout: Duration.seconds(30) }),
      );
      if (copy.code !== 0) return yield* Effect.fail(`copying: ${copy.stderr.trim()}`);
      const aside = path.join(stateDir(home), "adopted", String(yield* Clock.currentTimeMillis));
      yield* fs.makeDirectory(aside, { recursive: true });
      yield* fs.rename(src, path.join(aside, name));
      yield* Console.log(
        `skills/${name} is in the repo; the original is in ${aside}. The next sync links it and ${config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") ? "commits" : "proposes"} it.`,
      );
    }).pipe(reportUserErrors),
  ),
);

const add = Command.make("add", {
  source: Argument.String("source").pipe(Argument.withDescription("owner/repo or a git URL")),
  skills: Argument.String("skill").pipe(Argument.variadic()),
  as: Flag.String("as").pipe(
    Flag.withDescription("Vendor the one skill under another name (on a clash)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Vendor skills from a git repository into the config repo, with provenance.",
  ),
  Command.withHandler(({ source, skills, as }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const { names, landed } = yield* underSyncLock(
        Effect.gen(function* () {
          // What is there now, edits waiting to be proposed too, for putting back on a refusal.
          const before = yield* snapshot(config.repo, ["skills"]);
          const paths = yield* addSkills(
            config.repo,
            source,
            skills,
            as._tag === "Some" ? as.value : undefined,
          );
          const names = paths
            .filter((p) => p !== "skills/SOURCES.json")
            .map((p) => p.slice("skills/".length));
          return {
            names,
            landed: yield* land(
              config,
              paths,
              `Add skill${names.length === 1 ? "" : "s"} ${names.join(", ")} from ${source}`,
              before,
            ),
          };
        }),
      );
      yield* Console.log(`added ${names.join(", ")}: ${landed}`);
    }).pipe(reportUserErrors),
  ),
);

const update = Command.make("update", {
  skills: Argument.String("skill").pipe(Argument.variadic()),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Keep the changes without asking."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Re-pull vendored skills from where they came from; shows what changed and asks.",
  ),
  Command.withHandler(({ skills, yes }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      // The update waits in a scratch directory while you decide; the checkout only changes once you keep it.
      const preview = yield* previewUpdate(config.repo, skills);
      if (preview.skipped.length > 0)
        yield* Console.log(
          `skipping ${preview.skipped.join(", ")}: sync holds back an edit there that looks like a secret (t3-fleet secrets scan)`,
        );
      if (preview.files.length === 0) {
        yield* Console.log("every skill is current");
        return;
      }
      yield* Console.log(preview.stat);
      const keep =
        yes ||
        (process.stdin.isTTY === true &&
          (yield* Prompt.run(Prompt.Confirm({ message: "Keep these changes?" })).pipe(
            Effect.orElseSucceed(() => false),
          )));
      if (!keep) {
        yield* Console.log(
          process.stdin.isTTY === true ? "discarded" : "discarded; re-run with --yes to keep them",
        );
        return;
      }
      const landed = yield* underSyncLock(
        Effect.gen(function* () {
          // What is there now, edits waiting to be proposed too, for putting back on a refusal.
          const before = yield* snapshot(config.repo, ["skills"]);
          const paths = yield* keepUpdate(config.repo, skills, preview.digest);
          return yield* land(
            config,
            paths,
            `Update skill${paths.length === 1 ? "" : "s"} from upstream`,
            before,
          );
        }),
      );
      yield* Console.log(landed);
    }).pipe(reportUserErrors),
  ),
);

const remove = Command.make("remove", {
  skills: Argument.String("skill").pipe(Argument.variadic({ min: 1 })),
}).pipe(
  Command.withDescription("Drop vendored skills; every node unlinks them on its next sync."),
  Command.withHandler(({ skills }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const landed = yield* underSyncLock(
        Effect.gen(function* () {
          const before = yield* snapshot(config.repo, ["skills"]);
          const paths = yield* removeSkills(config.repo, skills);
          return yield* land(
            config,
            paths,
            `Remove skill${skills.length === 1 ? "" : "s"} ${skills.join(", ")}`,
            before,
          );
        }),
      );
      yield* Console.log(`removed ${skills.join(", ")}: ${landed}`);
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
export const withMcpServer = (text: string, name: string) =>
  withMcpListItem(text, ["servers", '"servers.add"'], '"servers.add"', name);

/** The [mcp] table of a node file: where its body starts and ends, or null. */
const MCP_HEADER = /^\[mcp\][ \t]*(?:#.*)?$/m;

const mcpTable = (text: string) => {
  const table = MCP_HEADER.exec(text);
  if (table === null) return null;
  const rest = text.slice(table.index);
  const end = rest.slice(1).search(/^\[/m);
  return { start: table.index, end: end === -1 ? text.length : table.index + end + 1 };
};

/** A one-line list `key = [ … ]`, a comment after it kept. Anything else is left to the check. */
const listLine = (key: string) =>
  new RegExp(
    `^(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[ \\t]*=[ \\t]*\\[([^\\]]*)\\]([ \\t]*#.*)?[ \\t]*$`,
    "m",
  );

/** A list's items, with an empty one from a trailing comma dropped. */
const listItems = (inner: string | undefined) =>
  (inner ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

/**
 * Add `name` to a list under a node file's [mcp]: the first of `keys` it has,
 * or a new `add` entry (a new [mcp] table if need be).
 */
const withMcpListItem = (text: string, keys: ReadonlyArray<string>, add: string, name: string) => {
  const table = mcpTable(text);
  if (table === null) return `${text.trimEnd()}\n\n[mcp]\n${add} = [${JSON.stringify(name)}]\n`;
  const body = text.slice(table.start, table.end);
  const list = keys.map((k) => listLine(k).exec(body)).find((m) => m !== null);
  const updated = list
    ? body.replace(
        list[0],
        `${list[1]} = [${[...listItems(list[2]), JSON.stringify(name)].join(", ")}]${list[3] ?? ""}`,
      )
    : body.replace(MCP_HEADER, (header) => `${header}\n${add} = [${JSON.stringify(name)}]`);
  return text.slice(0, table.start) + updated + text.slice(table.end);
};

/** Take `name` out of a list under a node file's [mcp], when it has one. */
const withoutMcpListItem = (text: string, key: string, name: string) => {
  const table = mcpTable(text);
  if (table === null) return text;
  const body = text.slice(table.start, table.end);
  const list = listLine(key).exec(body);
  if (list === null) return text;
  const items = listItems(list[2]).filter(
    (item) => item !== JSON.stringify(name) && item !== `'${name}'`,
  );
  return (
    text.slice(0, table.start) +
    body.replace(list[0], `${list[1]} = [${items.join(", ")}]${list[3] ?? ""}`) +
    text.slice(table.end)
  );
};

/**
 * Stop a node file's [mcp] from ignoring `name`: out of its own `ignore` and
 * `"ignore.add"`, and, unless its own `ignore` replaces what lower layers say,
 * into `"ignore.remove"` for a defaults or profile entry.
 */
export const withoutMcpIgnore = (text: string, name: string) => {
  const table = mcpTable(text);
  const replaces = table !== null && listLine("ignore").test(text.slice(table.start, table.end));
  const out = withoutMcpListItem(withoutMcpListItem(text, "ignore", name), '"ignore.add"', name);
  return replaces ? out : withMcpListItem(out, ['"ignore.remove"'], '"ignore.remove"', name);
};

/** Words in a variable's or header's name that make its value a credential. */
const CREDENTIAL_WORDS = new Set([
  "TOKEN",
  "SECRET",
  "KEY",
  "APIKEY",
  "PASSWORD",
  "PASSWD",
  "PAT",
  "AUTH",
  "AUTHORIZATION",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "BEARER",
  "SESSION",
]);

/** Whether a variable's or header's name says it holds a credential. */
const credentialName = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((word) => CREDENTIAL_WORDS.has(word));

/**
 * Whether a value is clearly no credential: nothing, a number, a boolean, a
 * path, or a URL without one (no user, password or credential-named query
 * parameter).
 */
export const isHarmless = (value: string) => {
  if (value === "" || /^-?\d+(\.\d+)?$/.test(value)) return true;
  if (/^(true|false|yes|no|on|off)$/i.test(value)) return true;
  if (/^(\/|~\/|\.\.?\/)/.test(value)) return true;
  const url = URL.parse(value);
  return (
    url !== null &&
    /^(https?|wss?):$/.test(url.protocol) &&
    url.username === "" &&
    url.password === "" &&
    ![...url.searchParams.keys()].some(credentialName)
  );
};

/**
 * Whether a value goes into the fleet's secrets: any value is, unless it is
 * clearly harmless, and even then when its name says it is a credential.
 */
export const isCredential = (name: string, value: string) =>
  credentialName(name) || /^(basic|bearer|token)\s/i.test(value) || !isHarmless(value);

/**
 * The name a server's credential is kept under in the fleet's secrets: the
 * variable's or header's own name, prefixed with the server's unless it starts
 * with it, and numbered when the name holds another value already.
 */
export const secretName = (
  server: string,
  key: string,
  value: string,
  secrets: Readonly<Record<string, string>>,
) => {
  const upper = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const prefix = upper(server);
  const own = upper(key);
  const joined = own === prefix || own.startsWith(`${prefix}_`) ? own : `${prefix}_${own}`;
  const base = /^[A-Z_]/.test(joined) ? joined : `MCP_${joined}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    const held = secrets[name];
    if (held === undefined || held === value) return name;
  }
};

/**
 * A definition from `mcp add`'s flags. A credential's value goes into the
 * fleet's secrets (`store`) and the definition refers to it as `$NAME`;
 * `$NAME` given on the command line already is such a reference, and a name
 * given to --literal keeps its value as it is.
 */
export const mcpDefinition = (input: {
  readonly name: string;
  readonly url: string | undefined;
  readonly command: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly tokenEnv: string | undefined;
  readonly env: ReadonlyArray<string>;
  readonly headers: ReadonlyArray<string>;
  readonly literal: ReadonlyArray<string>;
  readonly sse: boolean;
  readonly secrets: Readonly<Record<string, string>>;
}):
  | { readonly problem: string }
  | {
      readonly definition: Record<string, unknown>;
      readonly store: ReadonlyArray<{ readonly name: string; readonly value: string }>;
      readonly refs: ReadonlyArray<string>;
    } => {
  if ((input.url === undefined) === (input.command === undefined))
    return { problem: "give exactly one of --url or --command" };
  if (input.url !== undefined && input.env.length > 0)
    return { problem: "--env is for --command servers; an HTTP server takes --header" };
  if (input.command !== undefined && (input.headers.length > 0 || input.sse))
    return { problem: "--header and --sse are for --url servers" };
  const pairs: Array<readonly [string, string]> = [];
  for (const e of input.env) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(e);
    if (m?.[1] === undefined) return { problem: `not KEY=VALUE: ${e.split("=")[0]}` };
    pairs.push([m[1], m[2] ?? ""]);
  }
  for (const h of input.headers) {
    const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/s.exec(h);
    if (m?.[1] === undefined) return { problem: `not 'Name: value': ${h.split(":")[0]}` };
    pairs.push([m[1], m[2] ?? ""]);
  }
  const literal = (key: string) => input.literal.some((l) => l.toLowerCase() === key.toLowerCase());
  const stray = input.literal.find(
    (l) => !pairs.some(([key]) => key.toLowerCase() === l.toLowerCase()),
  );
  if (stray !== undefined) return { problem: `--literal ${stray} names no --env or --header` };
  const known: Record<string, string> = { ...input.secrets };
  const store: Array<{ name: string; value: string }> = [];
  const refs: Array<string> = [];
  const values: Record<string, string> = {};
  for (const [key, value] of pairs) {
    const ref = secretRef(value);
    if (ref !== null) refs.push(ref);
    if (ref !== null || literal(key) || !isCredential(key, value)) {
      values[key] = value;
      continue;
    }
    const name = secretName(input.name, key, value, known);
    known[name] = value;
    if (!store.some((s) => s.name === name)) store.push({ name, value });
    values[key] = `$${name}`;
  }
  const filled = Object.keys(values).length > 0;
  const definition =
    input.url !== undefined
      ? {
          kind: "direct",
          url: input.url,
          ...(input.sse ? { transport: "sse" } : {}),
          ...(filled ? { headers: values } : {}),
          ...(input.tokenEnv === undefined
            ? {}
            : { auth: { type: "bearer", token_env: input.tokenEnv } }),
        }
      : {
          kind: "stdio",
          command: input.command,
          args: [...input.args],
          ...(filled ? { env: values } : {}),
        };
  return { definition, store, refs };
};

/** A failure after the commit: the change is in the repo, and the next sync pushes it. */
const landedAnyway = (e: unknown) => typeof e === "string" && e.startsWith("committed");

/** JSON with every object's keys sorted: two tables are the same when this is. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value);

/**
 * Edits to node files, checked before any is written: in a scratch copy of
 * the fleet's settings, every node's merged settings must come out exactly as
 * they were, but with `name` in each edited node's [mcp] servers and out of
 * its ignore. Text edits cannot see every TOML form (a multi-line list, an
 * escaped name); when one goes wrong, this says what to edit by hand.
 */
const checkNodeEdits = (
  config: Config,
  before: Config,
  edits: ReadonlyArray<{ readonly target: string; readonly rel: string; readonly text: string }>,
  name: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (edits.length === 0) return;
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped();
      for (const entry of [FLEET_FILE, "profiles", "nodes"])
        if (yield* fs.exists(`${config.repo}/${entry}`))
          yield* fs.copy(`${config.repo}/${entry}`, `${scratch}/${entry}`);
      for (const edit of edits) yield* fs.writeFileString(`${scratch}/${edit.rel}`, edit.text);
      const by = (target: string) =>
        `${edits.map((e) => e.rel).join(", ")} cannot be edited safely${target}. Add "${name}" to [mcp] servers there by hand (and take it off [mcp] ignore), then run this again. Nothing was changed.`;
      const after = yield* loadConfigFrom(scratch, config.self).pipe(
        Effect.mapError((e) => by(` (the result would not load: ${String(e).split("\n")[0]})`)),
      );
      const normal = (table: Readonly<Record<string, unknown>>, edited: boolean) => {
        const mcp = (table["mcp"] ?? {}) as Readonly<Record<string, unknown>>;
        const list = (key: string) =>
          (Array.isArray(mcp[key]) ? (mcp[key] as Array<unknown>) : []).filter(
            (item) => !(edited && item === name),
          );
        return canonical({
          ...table,
          mcp: {
            ...mcp,
            servers: [...list("servers"), ...(edited ? [name] : [])].map(String).sort(),
            ignore: list("ignore").map(String).sort(),
          },
        });
      };
      for (const node of before.nodes) {
        const edited = edits.some((e) => e.target === node.name);
        const now = after.nodes.find((n) => n.name === node.name);
        if (
          now === undefined ||
          normal(now.settings.table, false) !== normal(node.settings.table, edited)
        )
          return yield* Effect.fail(by(""));
      }
    }),
  );

/** Declare an MCP server once; nodes listing it register it on their next sync. */
export const mcpAddCommand = Command.make("add", {
  name: Argument.String("name"),
  url: Flag.String("url").pipe(
    Flag.withDescription("A server reached directly over HTTP."),
    Flag.optional,
  ),
  command: Flag.String("command").pipe(
    Flag.withDescription("A stdio server: the command to run (use ~ for home)."),
    Flag.optional,
  ),
  arg: Flag.String("arg").pipe(
    Flag.withDescription("An argument for --command (repeatable)."),
    Flag.atLeast(0),
  ),
  env: Flag.String("env").pipe(
    Flag.withDescription(
      "KEY=VALUE for a --command server's environment (repeatable). $NAME is the fleet secret NAME; any other value but a number, boolean, path or plain URL is stored as one.",
    ),
    Flag.atLeast(0),
  ),
  header: Flag.String("header").pipe(
    Flag.withDescription(
      "'Name: value' sent to a --url server (repeatable). $NAME is the fleet secret NAME; any other value but a number, boolean, path or plain URL is stored as one.",
    ),
    Flag.atLeast(0),
  ),
  literal: Flag.String("literal").pipe(
    Flag.withDescription(
      "Keep this --env or --header value in the definition as it is, not as a secret (repeatable).",
    ),
    Flag.atLeast(0),
  ),
  sse: Flag.Boolean("sse").pipe(
    Flag.withDescription("The --url server speaks the older SSE transport (Claude only)."),
    Flag.withDefault(false),
  ),
  token: Flag.String("token-env").pipe(
    Flag.withDescription("Send this secret as a bearer token (set it with t3-fleet secrets set)."),
    Flag.optional,
  ),
  node: Flag.String("node").pipe(
    Flag.withDescription("Register on this node (repeatable); default every node."),
    Flag.atLeast(0),
  ),
}).pipe(
  Command.withDescription("Declare an MCP server in mcp/<name>.json and register it on nodes."),
  Command.withHandler(({ name, url, command, arg, env, header, literal, sse, token, node }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* loadConfig;
      if (!NAME_PATTERN.test(name))
        return yield* Effect.fail("names are lowercase letters, digits, - and _");
      const authority =
        config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") === true;
      const targets = [...new Set(node.length > 0 ? node : config.nodes.map((n) => n.name))];
      const done = yield* underSyncLock(
        Effect.gen(function* () {
          // Decided under the lock, from the secrets as they are now: a concurrent change is not lost.
          // An authority changes them; anywhere else the installed copy says which names are taken.
          const secretsText = authority
            ? yield* readSecrets(config.repo)
            : yield* fs
                .readFileString(localSecretsPath(process.env["HOME"] ?? ""))
                .pipe(Effect.orElseSucceed(() => ""));
          const secrets = parseSecrets(secretsText);
          const built = mcpDefinition({
            name,
            url: Option.getOrUndefined(url),
            command: Option.getOrUndefined(command),
            args: arg,
            tokenEnv: Option.getOrUndefined(token),
            env,
            headers: header,
            literal,
            sse,
            secrets,
          });
          if ("problem" in built) return yield* Effect.fail(built.problem);
          // Every check before the first change, against the nodes' settings as they are now.
          const fresh = yield* loadConfigFrom(config.repo, config.self);
          const nodeFiles: Array<{
            readonly target: string;
            readonly rel: string;
            readonly text: string;
          }> = [];
          for (const target of targets) {
            const settings = fresh.nodes.find((n) => n.name === target)?.settings.table["mcp"];
            if (settings === undefined && !fresh.nodes.some((n) => n.name === target))
              return yield* Effect.fail(`unknown machine: ${target}`);
            const list = (key: string) => {
              const value = (settings as Readonly<Record<string, unknown>> | undefined)?.[key];
              return Array.isArray(value) ? value : [];
            };
            const rel = `nodes/${target}.toml`;
            const text = yield* fs
              .readFileString(`${config.repo}/${rel}`)
              .pipe(Effect.mapError((e) => `cannot read ${rel}: ${e.message}`));
            let next = list("servers").includes(name) ? text : withMcpServer(text, name);
            // Adopting a server this machine ignored: it stops ignoring it.
            if (list("ignore").includes(name)) next = withoutMcpIgnore(next, name);
            if (next !== text) nodeFiles.push({ target, rel, text: next });
          }
          yield* checkNodeEdits(config, fresh, nodeFiles, name);
          const stored = authority ? built.store : [];
          const touched = [
            ...(stored.length > 0
              ? [encryptedPath(config.repo).slice(config.repo.length + 1)]
              : []),
            `mcp/${name}.json`,
            ...nodeFiles.map((f) => f.rel),
          ];
          // Only resolved index entries can be put back on a refusal: a merge in progress stops here.
          const conflicted = yield* unmergedHits(config.repo, touched);
          if (conflicted.length > 0)
            return yield* Effect.fail(
              `${conflicted.map((c) => c.file).join(", ")} ${conflicted.length === 1 ? "has" : "have"} an unresolved merge conflict; resolve it first. Nothing was changed.`,
            );
          // What is there now, edits and staged changes too, for putting back when the change does not land.
          const dirs: Array<string> = [];
          for (const dir of ["mcp", "nodes", "secrets"])
            if (yield* fs.exists(`${config.repo}/${dir}`)) dirs.push(dir);
          const before = yield* snapshot(config.repo, dirs);
          const index = yield* indexEntries(config.repo, touched);
          const landed = yield* Effect.gen(function* () {
            if (stored.length > 0) {
              let text = secretsText;
              for (const s of stored) text = setVar(text, s.name, s.value);
              yield* writeSecrets(config.repo, text);
            }
            yield* fs.writeFileString(
              `${config.repo}/mcp/${name}.json`,
              prettyJson(built.definition),
            );
            for (const f of nodeFiles) yield* fs.writeFileString(`${config.repo}/${f.rel}`, f.text);
            return yield* land(config, touched, `Add MCP server ${name}`, before, index);
          }).pipe(
            // Refused or failed before the commit: everything goes back, the index too.
            Effect.catchIf(
              (e) => !landedAnyway(e),
              (e) =>
                restorePaths(config.repo, touched, before, index).pipe(
                  Effect.ignore,
                  Effect.andThen(Effect.fail(e)),
                ),
            ),
            // Committed, and only the push failed: the change stands, and so does this machine's copy.
            Effect.tapError((e) =>
              landedAnyway(e) && stored.length > 0
                ? installSecrets(config.repo).pipe(Effect.ignore)
                : Effect.void,
            ),
          );
          // This machine's own copy only once the change has landed.
          if (stored.length > 0) yield* installSecrets(config.repo);
          return { landed, built, stored, secrets };
        }),
      );
      const { landed, built, stored, secrets } = done;
      yield* Console.log(`declared ${name} for ${targets.join(", ")}: ${landed}`);
      if (stored.length > 0)
        yield* Console.log(
          `kept ${stored.map((s) => s.name).join(", ")} in the fleet's secrets; the definition refers to ${stored.length === 1 ? "it" : "them"}`,
        );
      // Not an authority: the definition names the secrets, and someone sets them where secrets change.
      const unset = [
        ...new Set([
          ...(authority ? [] : built.store.map((s) => s.name)),
          ...built.refs.filter((r) => secrets[r] === undefined),
        ]),
      ];
      if (unset.length > 0)
        yield* Console.log(
          `${name} needs ${unset.join(", ")} in the fleet's secrets before it can connect; on an authority: t3-fleet secrets set ${unset.map((n) => `${n}=…`).join(" ")}`,
        );
    }).pipe(reportUserErrors),
  ),
);

/** What a fix runs to register a server in Claude; its secrets never reach a command line. */
export const mcpRegisterClaudeCommand = Command.make("register-claude", {
  name: Argument.String("name"),
  endpoint: Argument.String("endpoint").pipe(
    Argument.withDescription("The server's resolved definition, as `t3-fleet status` shows it."),
  ),
}).pipe(
  Command.withDescription(
    "Run by fixes: register an MCP server in Claude, filling its secrets in from this machine's.",
  ),
  Command.withHandler(({ name, endpoint }) =>
    Effect.gen(function* () {
      if (!NAME_PATTERN.test(name)) return yield* Effect.fail(`${name} is not a server name`);
      const resolved = yield* Schema.decodeEffect(Schema.fromJsonString(Endpoint))(endpoint).pipe(
        Effect.mapError(() => "not a resolved MCP definition"),
      );
      const problem = endpointProblem(resolved);
      if (problem !== null) return yield* Effect.fail(problem);
      const { file, tightened } = yield* registerInClaude(
        process.env["HOME"] ?? "",
        name,
        resolved,
        process.env,
      );
      yield* Console.log(`registered ${name} in Claude`);
      if (tightened !== null)
        yield* Console.log(
          `${file} holds secrets now, so it is readable by its owner alone (600, was ${tightened.toString(8)})`,
        );
    }).pipe(reportUserErrors),
  ),
);
