/**
 * The config repo as setup sees it: what a fleet already has (to plan
 * against), and the files a new fleet starts with.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import { loadConfigFrom } from "../Config.ts";
import { exec } from "../Exec.ts";
import { FLEET_FILE } from "../Names.ts";
import { keyPath, readSecrets, varNames } from "../Secrets.ts";
import { secretRefs } from "./Credentials.ts";
import { cleanUrl, hashSkill } from "./Discover.ts";
import { PROPOSED_SECRETS, type FleetView } from "./Plan.ts";
import { tomlValue } from "./TomlEdit.ts";

/** What sync commits (an authority) or proposes (any other machine) in a fleet setup starts. */
export const AUTO_COMMIT = [
  "skills",
  "mcp",
  "instructions",
  "nodes",
  PROPOSED_SECRETS,
  FLEET_FILE,
] as const;

/** T3 Fleet's own MCP server, declared in every fleet setup starts or joins. */
export const SELF_SERVER = {
  name: "t3-fleet",
  definition: { kind: "stdio", command: "~/.local/bin/t3-fleet", args: ["mcp"] },
} as const;

const decodeJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

const table = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * What the fleet in `repo` has, as machine `self` would get it: its own
 * merged settings when its node file exists (invited, or set up before),
 * the defaults otherwise.
 */
export const readFleet = (repo: string, self: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const list = (dir: string) =>
      fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const skills = new Map<string, string>();
    const skillTexts = new Map<string, string>();
    for (const name of (yield* list(path.join(repo, "skills"))).sort()) {
      const dir = path.join(repo, "skills", name);
      if (yield* fs.exists(path.join(dir, "SKILL.md")).pipe(Effect.orElseSucceed(() => false))) {
        skills.set(name, (yield* hashSkill(dir)).hash);
        skillTexts.set(
          name,
          yield* fs.readFileString(path.join(dir, "SKILL.md")).pipe(Effect.orElseSucceed(() => "")),
        );
      }
    }
    const servers = new Map<string, Record<string, unknown>>();
    for (const file of (yield* list(path.join(repo, "mcp"))).filter((f) => f.endsWith(".json"))) {
      const text = yield* fs.readFileString(path.join(repo, "mcp", file)).pipe(Effect.option);
      const value = Option.flatMap(text, decodeJson);
      if (Option.isSome(value)) servers.set(file.slice(0, -".json".length), table(value.value));
    }
    const fleetText = yield* fs
      .readFileString(path.join(repo, FLEET_FILE))
      .pipe(Effect.orElseSucceed(() => ""));
    const fleetToml = table(
      yield* Effect.try(() => parseToml(fleetText)).pipe(Effect.orElseSucceed(() => ({}))),
    );
    const invited = yield* fs
      .exists(path.join(repo, "nodes", `${self}.toml`))
      .pipe(Effect.orElseSucceed(() => false));
    const settings = invited
      ? Option.match(yield* loadConfigFrom(repo, self).pipe(Effect.option), {
          onNone: () => table(fleetToml["defaults"]),
          onSome: (c) => table(c.nodes.find((n) => n.name === self)?.settings.table as unknown),
        })
      : table(fleetToml["defaults"]);
    const mcp = table(settings["mcp"]);
    const names = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const entries = Array.isArray(settings["instructions"])
      ? (settings["instructions"] as Array<unknown>).map(table)
      : [];
    const instructions: Array<FleetView["instructions"][number]> = [];
    for (const e of entries) {
      if (typeof e["src"] !== "string" || typeof e["dest"] !== "string") continue;
      const text = yield* fs.readFileString(path.join(repo, e["src"])).pipe(Effect.option);
      instructions.push({ src: e["src"], dest: e["dest"], text: Option.getOrNull(text) });
    }
    // Names the repo already uses; an authority can also read the secrets file's own.
    // Only with a key this machine has already: planning creates nothing.
    const hasKey = yield* fs
      .exists(keyPath(process.env["HOME"] ?? ""))
      .pipe(Effect.orElseSucceed(() => false));
    const known = hasKey
      ? yield* readSecrets(repo).pipe(
          Effect.map(varNames),
          Effect.orElseSucceed(() => [] as Array<string>),
        )
      : [];
    const view: FleetView = {
      skills,
      skillTexts,
      servers,
      declared: names(mcp["servers"]),
      ignored: names(mcp["ignore"]),
      instructions,
      secretNames: [...new Set([...[...servers.values()].flatMap(secretRefs), ...known])],
    };
    /** This machine's merged [mcp] settings, as the mcp area would read them. */
    /** Whether this machine's settings turn the sync timer off (setup did, when it could not run one). */
    const timerOff = table(settings["engine"])["timer"] === false;
    return { view, mcp, timerOff };
  });

const list = (values: ReadonlyArray<string>) => tomlValue(values);

/** A new fleet's t3-fleet.toml: what every machine gets, with the first machine's skills, servers and instructions. */
export const newFleetFile = (options: {
  readonly checkout: string;
  readonly servers: ReadonlyArray<string>;
  readonly instructions: ReadonlyArray<{ readonly src: string; readonly dest: string }>;
}) =>
  [
    "# This fleet's settings. Machines are in nodes/; https://github.com/MartinPTielemans/fleetx explains every key.",
    "",
    "[fleet]",
    `checkout = ${JSON.stringify(options.checkout)}`,
    'branch = "main"',
    "interval = 900",
    "alert_after = 3",
    "# What sync commits on an authority, and proposes from any other machine for approval.",
    `auto_commit = ${list(AUTO_COMMIT)}`,
    "",
    "# Settings every machine gets unless its own file or a profile says otherwise.",
    "[defaults.engine]",
    "timer = true",
    "",
    "[defaults.skills]",
    'store = "~/.agents/skills"',
    'clients = ["~/.claude/skills"]',
    "# Codex reads ~/.agents/skills; its own directory is only checked for strays.",
    'watch = ["~/.codex/skills"]',
    "",
    "[defaults.mcp]",
    `servers = ${list(options.servers)}`,
    "",
    ...options.instructions.flatMap((i) => [
      "[[defaults.instructions]]",
      `src = ${JSON.stringify(i.src)}`,
      `dest = ${JSON.stringify(i.dest)}`,
      "",
    ]),
  ].join("\n");

/** A node file. `why` comments the roles. */
export const newNodeFile = (node: string, roles: ReadonlyArray<string>, by: string) =>
  `# ${node}: added by ${by}.\nroles = ${list(roles)}\n`;

export const GITIGNORE = [
  "secrets/*",
  "!secrets/secrets.env.age",
  "!secrets/recipients.toml",
  ".DS_Store",
  "",
].join("\n");

/**
 * Clone the fleet's repository into `dir`, writing no config anywhere (so
 * `setup --plan` changes nothing): T3 Fleet's git settings go in the
 * environment, with gh as GitHub's credential helper when gh is here.
 */
export const cloneFleet = (url: string, dir: string) =>
  Effect.gen(function* () {
    const gh = (yield* exec({
      command: "sh",
      args: ["-c", "command -v gh"],
      timeout: Duration.seconds(5),
    })).stdout.trim();
    const helper =
      gh === ""
        ? {}
        : {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
            GIT_CONFIG_VALUE_0: "",
            GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
            GIT_CONFIG_VALUE_1: `!${gh} auth git-credential`,
          };
    const clone = yield* exec({
      command: "git",
      args: ["clone", "-q", "--", url, dir],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        ...helper,
      },
      timeout: Duration.minutes(5),
    });
    if (clone.code !== 0)
      return yield* Effect.fail(
        `cloning ${cleanUrl(url)}: ${clone.stderr.trim().split("\n").pop() ?? `exit ${clone.code}`} (for GitHub: gh auth login)`.replaceAll(
          url,
          cleanUrl(url),
        ),
      );
  });
