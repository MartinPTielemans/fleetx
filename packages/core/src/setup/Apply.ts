/**
 * Setup's changes, in steps. A run is decided in full before its first step
 * (State.ts keeps it, its secret values encrypted), each step is recorded in
 * setup.json when it finishes, and every step can run again over its own
 * half-done work: a run that fails resumes at the step that failed and does
 * exactly what was decided.
 *
 *   snapshot  before.json, before anything else changes (State.ts)
 *   repo      first machine: the repository, its first commit, and its remote
 *   clone     joining machine: the fleet's repository, cloned into place
 *   content   skills, MCP definitions, instruction files, settings
 *   keys      this machine's key; secrets encrypted (an authority), or
 *             proposed encrypted for an authority to merge (any other)
 *   commit    first machine or an authority: commit and push (Git.commitAndPush)
 *   config    ~/.config/t3-fleet/config.toml
 *   links     what the repo now holds, linked into place; the originals moved
 *             to ~/.local/state/t3-fleet/setup/backup and listed in before.json
 *   t3        T3 Fleet's read-only token for T3 (t3-fleet t3 connect)
 *   sync      a first sync, applying only the areas setup covers
 *
 * A joining machine never commits to the branch: what it writes is listed
 * (State.addSetupProposed) and its sync proposes exactly that, whatever the
 * fleet's [fleet] auto_commit says.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import type { ProbeServices } from "../Area.ts";
import { loadConfig } from "../Config.ts";
import { exec } from "../Exec.ts";
import {
  addPaths,
  commitAndPush,
  ensureGitConfig,
  git,
  ok,
  out,
  refuseSecrets,
  scanCommits,
  why,
} from "../Git.ts";
import { writeLocalConfig } from "../Init.ts";
import { DEFAULT_RELAY_PORT, FLEET_FILE } from "../Names.ts";
import {
  encryptFor,
  ensureIdentity,
  installSecrets,
  localSecretsPath,
  readRecipients,
  readSecrets,
  setVar,
  SECRETS_FILES,
  writeRecipients,
  writeSecrets,
} from "../Secrets.ts";
import { refusal } from "../SecretScan.ts";
import { recordSources } from "../SkillSources.ts";
import { syncRun } from "../Sync.ts";
import { applyAreas, NTFY_SECRET } from "../Upkeep.ts";
import type { Secret } from "./Credentials.ts";
import { hostingOf } from "./HubHosting.ts";
import { cleanUrl, type Discovery } from "./Discover.ts";
import { PROPOSED_SECRETS, type Actions, type Mode } from "./Plan.ts";
import { settingsWords } from "./PlanWords.ts";
import type { Preflight } from "./Preflight.ts";
import { cloneFleet, GITIGNORE, newFleetFile, newNodeFile } from "./Repo.ts";
import { addSetupProposed, backupDir, recordMoved, takeSnapshot } from "./State.ts";
import { addToList, appendEntry, edits, removeFromList, setKey, type Edit } from "./TomlEdit.ts";

export interface Extras {
  /**
   * An always-on machine: the relay. `url` is where the others reach it;
   * `mcp` hosts the fleet's MCP servers there too ([defaults.mcp] hub).
   */
  readonly relay: {
    readonly url: string | null;
    readonly token: string | null;
    readonly mcp?: boolean;
  } | null;
  /** The model proxy, with Claude's long-lived token when one was given. */
  readonly models: { readonly token: string | null } | null;
  /** T3 Fleet's read-only token for T3. */
  readonly t3: boolean;
}

/** How the fleet looks after its machines (Upkeep.ts), as a run sets it. */
export interface Upkeep {
  /**
   * [fleet] apply with updates on or off, and [defaults.t3] update to match;
   * null leaves the fleet's as they are (a fleet this machine joins).
   */
  readonly autoUpdate: boolean | null;
  /**
   * This machine in [notify] desktop (an OS notification here for every
   * fleet alert), or out of it; null leaves it as it is (a machine set up
   * already, with no flag naming it).
   */
  readonly desktop: boolean | null;
  /** [notify] ntfy, the topic URL stored as T3_FLEET_NTFY_URL; null for no push. A saved run keeps no URL. */
  readonly ntfy: { readonly url: string | null } | null;
  /**
   * [defaults.mcp] hub on, served at `gateway` (the fleet's relay, set up
   * already), or off; null or absent leaves it. A new relay's MCP hub is
   * Extras.relay.mcp instead.
   */
  readonly mcpHub?: { readonly gateway: string } | false | null;
}

/**
 * Updates and notifications as a run takes them, whichever front end asked:
 * a fleet being joined keeps its own [fleet] apply.
 */
export const upkeepFor = (
  mode: Mode,
  chosen: {
    readonly autoUpdate: boolean | null;
    readonly desktop: boolean | null;
    readonly ntfy: string | null;
    readonly mcpHub?: { readonly gateway: string } | false | null;
  },
): Upkeep => ({
  autoUpdate: mode === "join" ? null : chosen.autoUpdate,
  // Off on a machine not in the fleet yet: nothing to take it out of.
  desktop: chosen.desktop === false && mode !== "again" ? null : chosen.desktop,
  ntfy: chosen.ntfy === null ? null : { url: chosen.ntfy },
  ...(chosen.mcpHub == null ? {} : { mcpHub: chosen.mcpHub }),
});

export interface SetupInput {
  readonly mode: Mode;
  readonly node: string;
  /** Where the config repo lives on this machine. */
  readonly checkout: string;
  /** The joining machine's fleet URL, and the scratch clone of it (gone on a resume: cloned again). */
  readonly join: { readonly url: string; readonly clone: string } | null;
  /** Whether this machine commits (first, or an authority) rather than proposing. */
  readonly commits: boolean;
  readonly actions: Actions;
  /** Client entries this run hands to the fleet: added to before.json by a later run. */
  readonly handed: ReadonlyArray<string>;
  readonly extras: Extras;
  readonly timer: Preflight["timer"];
  /** First machine: create this GitHub repository with gh, or push to an existing empty remote. */
  readonly remote: { readonly github: string } | { readonly url: string } | null;
  readonly now: number;
  /** The fleet's branch (config.branch); main when a saved run predates it. */
  readonly branch?: string;
  /** Updates and notifications; a run saved before setup asked about them sets neither. */
  readonly upkeep?: Upkeep;
}

export interface Step {
  readonly id: string;
  readonly title: string;
  /** What it did, a line each. */
  readonly run: Effect.Effect<ReadonlyArray<string>, string, ProbeServices>;
}

const fail = (what: string) => (e: unknown) =>
  `${what}: ${typeof e === "string" ? e : e instanceof Error ? e.message : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e)}`;

const sh = (command: string, args: ReadonlyArray<string>, seconds = 60) =>
  exec({ command, args, timeout: Duration.seconds(seconds) });

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const exists = (p: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(p)),
    Effect.orElseSucceed(() => false),
  );

/** Edit a TOML file in the checkout (creating it from `initial` when missing), or fail with why. */
const editToml = (file: string, initial: string, steps: ReadonlyArray<(text: string) => Edit>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const before = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => initial));
    let text = before;
    for (const step of steps) {
      const edit = step(text);
      if ("error" in edit) return yield* Effect.fail(`${file}: ${edit.error}`);
      text = edit.text;
    }
    if (text !== before || !(yield* exists(file))) yield* fs.writeFileString(file, text);
  });

/**
 * Copy a skill into the repo without .git (a clone committed as a gitlink
 * reaches no other machine) or node_modules. A skill kept as `name@node`
 * gets that name in its SKILL.md too.
 */
const copySkill = (from: string, to: string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* sh("rm", ["-rf", to], 30);
    yield* sh("mkdir", ["-p", to.slice(0, to.lastIndexOf("/"))], 5);
    const cp = yield* sh("cp", ["-R", from, to]);
    if (cp.code !== 0) return yield* Effect.fail(`copying ${from}: ${cp.stderr.trim()}`);
    for (const junk of [".git", "node_modules"])
      yield* sh("find", [to, "-name", junk, "-prune", "-exec", "rm", "-rf", "{}", "+"], 30);
    if (name.includes("@")) {
      const file = `${to}/SKILL.md`;
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      yield* fs.writeFileString(
        file,
        text.replace(/^(---\n(?:.*\n)*?)name:.*$/m, `$1name: ${name}`),
      );
    }
  });

/** Every secret setup stores: the servers', and the extras'. */
export const secretsToStore = (input: SetupInput): ReadonlyArray<Secret> => [
  ...input.actions.secrets,
  ...(input.extras.relay?.token != null
    ? [{ name: "T3_FLEET_RELAY_TOKEN", value: input.extras.relay.token, where: "relay" }]
    : []),
  ...(input.extras.models?.token != null
    ? [
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: input.extras.models.token,
          where: "claude setup-token",
        },
      ]
    : []),
  ...(input.upkeep?.ntfy?.url != null
    ? [{ name: NTFY_SECRET, value: input.upkeep.ntfy.url, where: "the ntfy topic setup made" }]
    : []),
];

/** A run as setup.json keeps it: no secret value, no credential in a URL. */
export const persistable = (input: SetupInput): SetupInput => ({
  ...input,
  join: input.join === null ? null : { ...input.join, url: cleanUrl(input.join.url) },
  remote:
    input.remote !== null && "url" in input.remote
      ? { url: cleanUrl(input.remote.url) }
      : input.remote,
  actions: {
    ...input.actions,
    secrets: input.actions.secrets.map((s) => ({ ...s, value: "" })),
  },
  extras: {
    ...input.extras,
    relay: input.extras.relay === null ? null : { ...input.extras.relay, token: null },
    models: input.extras.models === null ? null : { token: null },
  },
  ...(input.upkeep === undefined
    ? {}
    : {
        upkeep: {
          ...input.upkeep,
          ntfy: input.upkeep.ntfy === null ? null : { url: null },
        },
      }),
});

/**
 * A saved run with its secret values back, from the NAME=value text saved
 * beside it; or the names it lacks, which a resume must not write empty.
 */
export const restored = (
  saved: SetupInput,
  secrets: string,
): SetupInput | { readonly missing: ReadonlyArray<string> } => {
  const values = new Map<string, string>();
  for (const line of secrets.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] === undefined) continue;
    const raw = m[2] ?? "";
    values.set(m[1], /^".*"$/.test(raw) ? raw.slice(1, -1).replace(/\\(["\\$`])/g, "$1") : raw);
  }
  const value = (name: string) => values.get(name) ?? null;
  const missing = [
    ...saved.actions.secrets.map((s) => s.name),
    ...(saved.extras.relay === null ? [] : ["T3_FLEET_RELAY_TOKEN"]),
    ...(saved.upkeep?.ntfy == null ? [] : [NTFY_SECRET]),
  ].filter((n) => !values.has(n) || values.get(n) === "");
  if (missing.length > 0) return { missing };
  return {
    ...saved,
    actions: {
      ...saved.actions,
      secrets: saved.actions.secrets.map((s) => ({ ...s, value: value(s.name) ?? "" })),
    },
    extras: {
      ...saved.extras,
      relay:
        saved.extras.relay === null
          ? null
          : { ...saved.extras.relay, token: value("T3_FLEET_RELAY_TOKEN") },
      models: saved.extras.models === null ? null : { token: value("CLAUDE_CODE_OAUTH_TOKEN") },
    },
    ...(saved.upkeep === undefined
      ? {}
      : {
          upkeep: {
            ...saved.upkeep,
            ntfy: saved.upkeep.ntfy === null ? null : { url: value(NTFY_SECRET) },
          },
        }),
  };
};

/** The repo paths this run writes: what a joining machine proposes. */
export const writtenPaths = (input: SetupInput) => [
  ...input.actions.skills.map((s) => `skills/${s.name}`),
  ...(input.actions.skills.some((s) => s.source !== null) ? ["skills/SOURCES.json"] : []),
  // Turning the MCP hub on rewrites every definition it can host, not only those added here.
  ...(turnsMcpHubOn(input) ? ["mcp"] : input.actions.servers.map((s) => `mcp/${s.name}.json`)),
  ...input.actions.instructions.map((i) => i.src),
  FLEET_FILE,
  `nodes/${input.node}.toml`,
  `${PROPOSED_SECRETS}/${input.node}.env.age`,
];

/** What an authority's run commits: the paths it writes, and the secrets the keys step wrote. */
export const commitPaths = (input: SetupInput) => [
  ...writtenPaths(input).filter((p) => !p.startsWith(`${PROPOSED_SECRETS}/`)),
  ...SECRETS_FILES,
];

export const rolesOf = (text: string): Array<string> => {
  try {
    const roles = (parseToml(text) as { roles?: unknown }).roles;
    return Array.isArray(roles)
      ? roles.filter((r): r is string => typeof r === "string")
      : ["member"];
  } catch {
    return ["member"];
  }
};

/** Whether a node file turns the sync timer off. */
export const timerOff = (text: string) => {
  try {
    return (parseToml(text) as { engine?: { timer?: unknown } }).engine?.timer === false;
  } catch {
    return false;
  }
};

/** The destinations `[[defaults.instructions]]` lists already. */
const listedDests = (text: string): ReadonlySet<unknown> => {
  try {
    const defaults = (parseToml(text) as { defaults?: { instructions?: unknown } }).defaults;
    const list = Array.isArray(defaults?.instructions) ? defaults.instructions : [];
    return new Set(list.map((e) => (e as { dest?: unknown }).dest));
  } catch {
    return new Set();
  }
};

/**
 * [relay] with its port (and url, once known), and `relay` in [fleet] apply
 * when the fleet lists its areas, so sync starts the relay and the listeners
 * by itself (without the key, the default includes it).
 */
export const relayEdits = (text: string, url: string | null): Edit =>
  edits(
    text,
    (t) => setKey(t, ["relay"], "port", DEFAULT_RELAY_PORT),
    (t) => (url === null ? { text: t } : setKey(t, ["relay"], "url", url)),
    applyRelay,
  );

/** `relay` added to [fleet] apply when the key lists areas without it; nothing when the key is not there. */
export const applyRelay = (text: string): Edit => {
  const apply = valueAt(text, ["fleet", "apply"]);
  return Array.isArray(apply) && !apply.includes("relay")
    ? addToList(text, ["fleet"], "apply", ["relay"])
    : { text };
};

const valueAt = (text: string, path: ReadonlyArray<string>): unknown => {
  try {
    let at: unknown = parseToml(text);
    for (const key of path)
      at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[key] : undefined;
    return at;
  } catch {
    return undefined;
  }
};

/** The fleet's relay URL ([relay] url), when it has one. */
export const relayUrlIn = (fleetText: string): string | null => {
  const url = valueAt(fleetText, ["relay", "url"]);
  return typeof url === "string" && url !== "" ? url : null;
};

/** Whether a t3-fleet.toml pushes alerts to ntfy already ([notify] ntfy). */
export const pushesToNtfy = (fleetText: string) =>
  valueAt(fleetText, ["notify", "ntfy"]) !== undefined;

/** Whether a run turns the MCP hub on: the terminal's --relay --mcp-hub, or --mcp-hub on a fleet with a relay. */
export const turnsMcpHubOn = (input: SetupInput) =>
  (input.extras.relay?.mcp === true && input.extras.relay.url !== null) ||
  (input.upkeep?.mcpHub != null && input.upkeep.mcpHub !== false);

const AnyObject = Schema.Record(Schema.String, Schema.Unknown);

/**
 * The repo's MCP definitions the hub can host, rewritten for it (HubHosting.ts):
 * what moved, what stays on each machine and why, and the files changed.
 */
export const moveServersToHub = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = (yield* fs
      .readDirectory(`${repo}/mcp`)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const moved: Array<string> = [];
    const stayed: Array<{ name: string; why: string }> = [];
    const files: Array<string> = [];
    for (const file of names) {
      const name = file.slice(0, -".json".length);
      const definition = yield* fs
        .readFileString(`${repo}/mcp/${file}`)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(AnyObject))), Effect.option);
      if (Option.isNone(definition)) {
        stayed.push({ name, why: "its definition is not a JSON object" });
        continue;
      }
      const hosting = hostingOf(definition.value);
      if (hosting.on === "machines") stayed.push({ name, why: hosting.why });
      else if (hosting.definition !== null) {
        yield* fs.writeFileString(`${repo}/mcp/${file}`, pretty(hosting.definition));
        moved.push(name);
        files.push(`mcp/${file}`);
      }
    }
    return { moved, stayed, files };
  });

/** What moveServersToHub did, in the plan's words. */
export const movedLines = (
  node: string,
  moved: {
    readonly moved: ReadonlyArray<string>;
    readonly stayed: ReadonlyArray<{ readonly name: string; readonly why: string }>;
  },
) => [
  ...(moved.moved.length === 0 ? [] : [`moved to ${node}: ${moved.moved.join(", ")}`]),
  ...moved.stayed.map((s) => `${s.name} stays on each machine: ${s.why}`),
];

/** [defaults.mcp]: the relay hosts every machine's MCP servers, reached at `gateway` (docs/topologies.md). */
export const mcpHubEdits = (text: string, gateway: string): Edit =>
  edits(
    text,
    (t) => setKey(t, ["defaults", "mcp"], "hub", true),
    (t) => setKey(t, ["defaults", "mcp"], "gateway", gateway),
  );

/** [fleet] apply, [defaults.t3] update and [notify], as `upkeep` says; nothing for a run that did not ask. */
export const upkeepEdits = (
  upkeep: Upkeep | undefined,
  node: string,
): ReadonlyArray<(text: string) => Edit> => {
  if (upkeep === undefined) return [];
  const out: Array<(text: string) => Edit> = [];
  const auto = upkeep.autoUpdate;
  if (auto !== null) {
    out.push((t) =>
      setKey(
        t,
        ["fleet"],
        "apply",
        [...applyAreas(auto)],
        auto
          ? "Areas whose safe fixes sync applies by itself; updates included (T3 waits until no thread runs)."
          : "Areas whose safe fixes sync applies by itself; add t3, agents and skills to keep them up to date too.",
      ),
    );
    out.push((t) =>
      auto
        ? setKey(t, ["defaults", "t3"], "update", "when-idle")
        : valueAt(t, ["defaults", "t3", "update"]) === undefined
          ? { text: t }
          : setKey(t, ["defaults", "t3"], "update", "manual"),
    );
  }
  if (upkeep.desktop === true) out.push((t) => addToList(t, ["notify"], "desktop", [node]));
  if (upkeep.desktop === false) out.push((t) => removeFromList(t, ["notify"], "desktop", [node]));
  if (upkeep.ntfy !== null) out.push((t) => setKey(t, ["notify"], "ntfy", NTFY_SECRET));
  const hub = upkeep.mcpHub;
  if (hub != null && hub !== false) out.push((t) => mcpHubEdits(t, hub.gateway));
  if (hub === false)
    out.push((t) =>
      valueAt(t, ["defaults", "mcp", "hub"]) === true
        ? setKey(t, ["defaults", "mcp"], "hub", false)
        : { text: t },
    );
  return out;
};

/** What a run sets for looking after the machines, in plain words, for its plan. */
export const settingsLines = (input: SetupInput): ReadonlyArray<string> =>
  settingsWords({
    node: input.node,
    mcpHub:
      (input.extras.relay?.mcp === true && input.extras.relay.url !== null) ||
      (input.upkeep?.mcpHub != null && input.upkeep.mcpHub !== false),
    mcpHubOff: input.upkeep?.mcpHub === false,
    autoUpdate: input.upkeep?.autoUpdate ?? null,
    desktop: input.upkeep?.desktop ?? null,
    ntfy: input.upkeep?.ntfy != null,
  });

/** Setup's first sync: everything but MCP until this machine reads the fleet's secrets. */
export const firstSync = (repo: string) =>
  Effect.gen(function* () {
    // A fleet with no remote yet is complete here; syncing (and publishing) waits for one.
    if (out(yield* git(repo, ["remote", "get-url", "origin"])) === "")
      return [
        "skipped: the repo has no remote yet. Add one, then sync:",
        `  git -C ${repo} remote add origin <url> && git -C ${repo} push -u origin main`,
        "  t3-fleet sync",
      ];
    const config = yield* loadConfig.pipe(Effect.mapError((e) => e.message));
    // MCP servers wait until this machine can read the fleet's secrets: registered without them, they would lose their credentials.
    const readable = yield* readSecrets(repo).pipe(Effect.option);
    const areas = [
      "engine",
      "secrets",
      "skills",
      "instructions",
      "dotfiles",
      // The listener (or, on the hub, the relay) once this machine has the relay token.
      "relay",
      ...(Option.isSome(readable) ? ["mcp"] : []),
    ];
    const result = yield* syncRun(config, { apply: true, areas });
    const lines = [...result.lines];
    if (Option.isNone(readable))
      lines.push(
        "MCP servers are registered once an authority's next sync adds this machine's key",
      );
    if (result.state !== null && result.state.result !== "ok")
      return yield* Effect.fail(`sync incomplete: ${result.state.message}`);
    return lines;
  });

/** The steps for this run, in order. `hooks` are what only the command can do. */
export const setupSteps = (
  input: SetupInput,
  hooks: {
    readonly t3Connect: Effect.Effect<string, string, ProbeServices>;
    /** The clients' entries as they are now, for the snapshot (never persisted: they hold credentials). */
    readonly raw: Discovery["raw"];
  },
): ReadonlyArray<Step> => {
  const home = process.env["HOME"] ?? "";
  const repo = input.checkout;
  const nodeFile = `${repo}/nodes/${input.node}.toml`;
  const fleetFile = `${repo}/${FLEET_FILE}`;
  const steps: Array<Step> = [];

  steps.push({
    id: "snapshot",
    title: "snapshot of the clients' MCP servers (for t3-fleet leave)",
    run: takeSnapshot(home, input.now, hooks.raw, input.handed).pipe(
      Effect.map(() => ["~/.local/state/t3-fleet/setup/before.json"]),
      Effect.mapError(fail("snapshot")),
    ),
  });

  if (input.mode === "first") {
    steps.push({
      id: "repo",
      title: `the config repo at ${repo}`,
      run: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lines: Array<string> = [];
        // Each part only when it is missing, so a run that stopped half-way picks up where it was.
        if (!(yield* exists(`${repo}/.git`)) && !(yield* exists(fleetFile))) {
          const files = yield* fs
            .readDirectory(repo)
            .pipe(Effect.orElseSucceed(() => [] as Array<string>));
          if (files.length > 0)
            return yield* Effect.fail(
              `${repo} already exists and is not empty; move it aside (or, from a terminal, choose another place with \`t3-fleet setup --dir <path>\`)`,
            );
        }
        yield* fs.makeDirectory(`${repo}/nodes`, { recursive: true });
        if (!(yield* exists(fleetFile)))
          yield* fs.writeFileString(
            fleetFile,
            newFleetFile({
              checkout: repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo,
              servers: [],
              instructions: [],
            }),
          );
        if (!(yield* exists(nodeFile))) {
          const roles = input.extras.relay === null ? ["authority"] : ["authority", "relay"];
          yield* fs.writeFileString(nodeFile, newNodeFile(input.node, roles, "t3-fleet setup"));
        }
        if (!(yield* exists(`${repo}/.gitignore`)))
          yield* fs.writeFileString(`${repo}/.gitignore`, GITIGNORE);
        yield* ensureGitConfig;
        if (!(yield* exists(`${repo}/.git`))) {
          const init = yield* git(repo, ["init", "-q", "-b", "main"]);
          if (!ok(init)) return yield* Effect.fail(`git init: ${why(init)}`);
        }
        if (!ok(yield* git(repo, ["rev-parse", "-q", "--verify", "HEAD"]))) {
          yield* git(repo, ["add", "--", FLEET_FILE, "nodes", ".gitignore"]);
          yield* refuseSecrets(repo);
          const commit = yield* git(repo, [
            "commit",
            "-q",
            "-m",
            `Start the fleet on ${input.node}`,
          ]);
          if (!ok(commit)) return yield* Effect.fail(`git commit: ${why(commit)}`);
          lines.push(`created ${repo}`);
        }
        const origin = out(yield* git(repo, ["remote", "get-url", "origin"]));
        if (origin === "" && input.remote !== null) {
          if ("github" in input.remote) {
            // Created empty, with origin set; the commit step pushes.
            const gh = yield* sh(
              "gh",
              [
                "repo",
                "create",
                input.remote.github,
                "--private",
                "--source",
                repo,
                "--remote",
                "origin",
              ],
              120,
            );
            if (gh.code !== 0)
              return yield* Effect.fail(
                `gh repo create ${input.remote.github}: ${gh.stderr.trim().split("\n").pop() ?? ""} (pass --github <owner/name> for another name)`,
              );
            lines.push(`created the private repository ${input.remote.github}`);
          } else {
            yield* git(repo, ["remote", "add", "origin", input.remote.url]);
            lines.push(`origin is ${cleanUrl(input.remote.url)}`);
          }
        }
        // Pushed by the commit step, through commitAndPush: scanned from the first commit.
        return lines;
      }).pipe(Effect.mapError(fail("creating the repo"))),
    });
  }

  if (input.join !== null) {
    const join = input.join;
    steps.push({
      id: "clone",
      title: `the fleet's repo at ${repo}`,
      run: Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* ensureGitConfig;
        if (yield* exists(`${repo}/.git`)) {
          const origin = out(yield* git(repo, ["remote", "get-url", "origin"]));
          if (cleanUrl(origin) === cleanUrl(join.url))
            return [`${repo} is already a clone of ${cleanUrl(join.url)}`];
          return yield* Effect.fail(
            `${repo} already holds another repository (${cleanUrl(origin) || "no remote"}); move it aside (or, from a terminal, choose another place with \`t3-fleet setup --dir <path>\`)`,
          );
        }
        if (yield* exists(repo))
          return yield* Effect.fail(
            `${repo} already exists; move it aside (or, from a terminal, choose another place with \`t3-fleet setup --dir <path>\`)`,
          );
        yield* fs.makeDirectory(repo.slice(0, repo.lastIndexOf("/")), { recursive: true });
        if (yield* exists(`${join.clone}/.git`)) {
          // The plan's clone, from a temporary directory: mv crosses filesystems where rename cannot.
          const mv = yield* sh("mv", [join.clone, repo]);
          if (mv.code !== 0)
            return yield* Effect.fail(`moving the clone into place: ${mv.stderr.trim()}`);
        } else yield* cloneFleet(join.url, repo);
        return [`cloned ${cleanUrl(join.url)} into ${repo}`];
      }).pipe(Effect.mapError(fail("cloning"))),
    });
  }

  steps.push({
    id: "content",
    title: "skills, MCP servers, instructions and settings in the repo",
    run: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const a = input.actions;
      const lines: Array<string> = [];
      for (const s of a.skills) yield* copySkill(s.from, `${repo}/skills/${s.name}`, s.name);
      const sourced = a.skills.flatMap((s) =>
        s.source === null ? [] : [{ name: s.name, ...s.source }],
      );
      if (sourced.length > 0) yield* recordSources(repo, sourced);
      if (a.skills.length > 0) lines.push(`skills: ${a.skills.map((s) => s.name).join(", ")}`);
      if (a.servers.length > 0) {
        yield* fs.makeDirectory(`${repo}/mcp`, { recursive: true });
        for (const s of a.servers)
          yield* fs.writeFileString(`${repo}/mcp/${s.name}.json`, pretty(s.definition));
        lines.push(`MCP servers: ${a.servers.map((s) => s.name).join(", ")}`);
      }
      for (const i of a.instructions) {
        const file = `${repo}/${i.src}`;
        yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        yield* fs.writeFileString(file, i.text);
      }
      if (a.instructions.length > 0)
        lines.push(`instructions: ${a.instructions.map((i) => i.dest).join(", ")}`);

      const fleet = a.servers.filter((s) => s.scope === "fleet").map((s) => s.name);
      const machine = a.servers.filter((s) => s.scope === "machine").map((s) => s.name);
      yield* editToml(fleetFile, "", [
        (t) =>
          fleet.length === 0 ? { text: t } : addToList(t, ["defaults", "mcp"], "servers", fleet),
        // An instruction the fleet already lists keeps its entry; only its file changes.
        ...a.instructions.map(
          (i) => (t: string) =>
            listedDests(t).has(i.dest)
              ? { text: t }
              : appendEntry(t, ["defaults", "instructions"], { src: i.src, dest: i.dest }),
        ),
        (t) =>
          input.extras.relay === null || /^\[relay\]/m.test(t)
            ? { text: t }
            : relayEdits(t, input.extras.relay.url),
        (t) => (input.extras.relay === null ? { text: t } : applyRelay(t)),
        (t) =>
          input.extras.relay?.mcp === true && input.extras.relay.url !== null
            ? mcpHubEdits(t, input.extras.relay.url)
            : { text: t },
        ...(input.extras.models === null
          ? []
          : [
              (t: string) =>
                /^\[defaults\.models\]/m.test(t)
                  ? { text: t }
                  : setKey(t, ["defaults", "models"], "egress", "direct"),
            ]),
        ...upkeepEdits(input.upkeep, input.node),
      ]);
      if (turnsMcpHubOn(input)) {
        const moved = yield* moveServersToHub(repo);
        lines.push(...movedLines("the hub", moved));
      }
      const roles = input.extras.relay === null ? ["member"] : ["relay", "member"];
      const ignored = a.ignored.map((i) => i.name);
      yield* editToml(nodeFile, newNodeFile(input.node, roles, "t3-fleet setup"), [
        (t) => (machine.length === 0 ? { text: t } : addToList(t, ["mcp"], "servers.add", machine)),
        (t) =>
          a.serversHereOnly.length === 0
            ? { text: t }
            : addToList(t, ["mcp"], "servers.remove", a.serversHereOnly),
        (t) => (ignored.length === 0 ? { text: t } : addToList(t, ["mcp"], "ignore.add", ignored)),
        (t) =>
          a.instructionsHereOnly.length === 0
            ? { text: t }
            : addToList(t, [], "instructions.remove", a.instructionsHereOnly),
        // Off while this machine cannot run it; on again once it can (lingering enabled since, say).
        (t) =>
          !input.timer.works
            ? setKey(t, ["engine"], "timer", false, input.timer.why)
            : timerOff(t)
              ? setKey(t, ["engine"], "timer", true)
              : { text: t },
        (t) => {
          const current = rolesOf(t);
          return input.extras.relay === null || current.includes("relay")
            ? { text: t }
            : setKey(t, [], "roles", [...current, "relay"]);
        },
      ]);
      if (!input.commits) yield* addSetupProposed(home, writtenPaths(input));
      return lines;
    }).pipe(Effect.mapError(fail("writing the repo"))),
  });

  steps.push({
    id: "keys",
    title: input.commits
      ? "this machine's key, and the secrets encrypted"
      : "this machine's key, and its secrets proposed",
    run: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { recipient } = yield* ensureIdentity;
      const store = secretsToStore(input);
      const recipients = yield* readRecipients(repo);
      if (input.commits) {
        if (recipients[input.node] !== recipient)
          yield* writeRecipients(repo, { ...recipients, [input.node]: recipient });
        let text = input.mode === "first" ? "" : yield* readSecrets(repo);
        for (const s of store) text = setVar(text, s.name, s.value);
        if (input.mode === "first" || store.length > 0) yield* writeSecrets(repo, text);
        yield* installSecrets(repo);
        return [
          `key ${recipient}`,
          ...(store.length > 0
            ? [`${store.length} secret${store.length === 1 ? "" : "s"} encrypted`]
            : []),
        ];
      }
      if (store.length === 0) return [`key ${recipient}`];
      // For every machine that can read the fleet's secrets (an authority merges them), and this one.
      let plain = "";
      for (const s of store) plain = setVar(plain, s.name, s.value);
      const armored = yield* encryptFor(
        [...new Set([...Object.values(recipients), recipient])],
        plain,
      );
      yield* fs.makeDirectory(`${repo}/${PROPOSED_SECRETS}`, { recursive: true });
      yield* fs.writeFileString(`${repo}/${PROPOSED_SECRETS}/${input.node}.env.age`, armored);
      // Here they work at once; the fleet's own replace them once an authority merges these.
      const local = yield* fs
        .readFileString(localSecretsPath(home))
        .pipe(Effect.orElseSucceed(() => ""));
      let merged = local;
      for (const s of store) merged = setVar(merged, s.name, s.value);
      yield* fs.makeDirectory(
        localSecretsPath(home).slice(0, localSecretsPath(home).lastIndexOf("/")),
        { recursive: true },
      );
      yield* fs.writeFileString(localSecretsPath(home), merged, { mode: 0o600 });
      yield* fs.chmod(localSecretsPath(home), 0o600);
      return [
        `key ${recipient}`,
        `${store.length} secret${store.length === 1 ? "" : "s"} proposed, encrypted, in ${PROPOSED_SECRETS}/${input.node}.env.age`,
      ];
    }).pipe(Effect.mapError(fail("secrets"))),
  });

  if (input.commits) {
    steps.push({
      id: "commit",
      title: "commit and push",
      run: Effect.gen(function* () {
        // Exactly what this run wrote: nothing else in the checkout is the plan's to publish.
        const paths = commitPaths(input);
        const origin = out(yield* git(repo, ["remote", "get-url", "origin"]));
        if (origin !== "") {
          const rev = yield* commitAndPush(repo, paths, `Set up ${input.node}`);
          if (rev !== "nothing to commit") return [`committed and pushed ${rev}`];
          return [yield* pushLeftover(repo, input.branch ?? "main")];
        }
        // No remote yet: commit here, scanned as commitAndPush would; pushing is the next step shown.
        yield* addPaths(repo, paths);
        yield* refuseSecrets(repo);
        const commit = yield* git(repo, ["commit", "-q", "-m", `Set up ${input.node}`]);
        return [ok(commit) ? "committed (no remote yet)" : "nothing new to commit"];
      }).pipe(Effect.mapError(fail("committing"))),
    });
  }

  steps.push({
    id: "config",
    title: "~/.config/t3-fleet/config.toml",
    run: writeLocalConfig(repo, input.node).pipe(
      Effect.map(() => [`this machine is ${input.node}, its repo ${repo}`]),
      Effect.mapError(fail("writing the local config")),
    ),
  });

  steps.push({
    id: "links",
    title: "skills and instructions linked from the repo",
    run: linkAll(input.actions.links, `${backupDir(home)}/${input.now}`, home).pipe(
      Effect.mapError(fail("linking")),
    ),
  });

  if (input.extras.t3)
    steps.push({
      id: "t3",
      title: "T3 Fleet's read-only token for T3",
      // Optional: without it T3 Fleet reads less about T3, and says so in status.
      run: hooks.t3Connect.pipe(
        Effect.map((line) => [line]),
        Effect.catch((why) => Effect.succeed([`skipped (${why}); later: t3-fleet t3 connect`])),
      ),
    });

  steps.push({
    id: "sync",
    title: "a first sync",
    run: firstSync(repo).pipe(Effect.mapError(fail("the first sync"))),
  });
  return steps;
};

/**
 * Commits an earlier run made but could not push (a resume after a failed
 * push): scanned as commitAndPush scans, from the root when the remote has
 * nothing yet, then pushed.
 */
export const pushLeftover = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const empty =
      (yield* git(repo, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`])).code === 2;
    const range = empty ? "HEAD" : `origin/${branch}..HEAD`;
    if (!empty && out(yield* git(repo, ["rev-list", "--count", range])) === "0")
      return "nothing new to commit";
    const hits = yield* scanCommits(repo, [range]);
    if (hits.length > 0) return yield* Effect.fail(refusal(hits, "push"));
    const push = yield* git(
      repo,
      empty ? ["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`] : ["push", "-q"],
    );
    if (!ok(push)) return yield* Effect.fail(`the push failed: ${why(push)}`);
    return "pushed what an earlier run committed";
  });

/**
 * Replace each path with its link. What is there is recorded in before.json,
 * then moved into `backups` (keeping its path under ~); a path that already
 * links where it should is left as it is.
 */
export const linkAll = (
  links: ReadonlyArray<{ readonly path: string; readonly link: string | null }>,
  backups: string,
  home: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let moved = 0;
    let linked = 0;
    for (const { path: at, link } of links) {
      const current = yield* fs.readLink(at).pipe(Effect.option);
      if (link !== null && Option.isSome(current)) {
        const [real, want] = yield* Effect.all([
          fs.realPath(at).pipe(Effect.orElseSucceed(() => "")),
          fs.realPath(link).pipe(Effect.orElseSucceed(() => link)),
        ]);
        if (real === want) continue;
      }
      if (Option.isSome(current) || (yield* exists(at))) {
        const rel = at.startsWith(`${home}/`) ? at.slice(home.length + 1) : at.replace(/^\//, "");
        const backup = path.join(backups, rel);
        yield* fs.makeDirectory(path.dirname(backup), { recursive: true });
        // Listed first: a run that stops between the two still says where the original went.
        yield* recordMoved(home, at, backup);
        yield* fs.rename(at, backup);
        moved++;
      }
      if (link !== null) {
        yield* fs.makeDirectory(path.dirname(at), { recursive: true });
        yield* fs.symlink(link, at);
        linked++;
      }
    }
    return [`${linked} linked, ${moved} moved aside to ${backups.replace(home, "~")}`];
  });
