/**
 * Where a user's setup lives, and what it says.
 *
 * The engine knows nothing about anyone's machines. Each machine has one
 * small local file, ~/.config/t3-fleet/config.toml, naming the user's private
 * config repository and which node this machine is:
 *
 *   repo = "~/my-fleet"
 *   node = "laptop"
 *
 * The repository holds the setup itself:
 *
 *   t3-fleet.toml          the whole fleet: [fleet], [proxy], [defaults], [[accept]]
 *   profiles/<name>.toml settings shared by the nodes that list the profile
 *   nodes/<name>.toml    one machine: ssh, roles, profiles, its own settings
 *
 * T3_FLEET_CONFIG_REPO and T3_FLEET_NODE override the local file.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import { BuildId } from "./Build.ts";
import { mergeLayers, type Layer, type Merged, type Table } from "./Settings.ts";
import { configDir, FLEET_FILE } from "./Names.ts";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

/** `~/x` → `<home>/x`. Config paths stay portable across machines. */
export const expandHome = (path: string, home: string) =>
  path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path;

export const ROLES = ["authority", "relay", "member"] as const;
export type Role = (typeof ROLES)[number];

const LocalFile = Schema.Struct({ repo: Schema.String, node: Schema.optionalKey(Schema.String) });

/**
 * A model proxy that providers can be routed through: a launcher per T3
 * provider instance, and the per-machine credentials file
 * ({"endpoint": "...", "api_key": "..."}, an OpenAI-compatible base URL).
 */
const ProxySettings = Schema.Struct({
  credentials: Schema.String,
  launchers: Schema.Record(Schema.String, Schema.String),
  /** Command that points T3's provider at its launcher; `{provider}` is the instance id. */
  enable: Schema.optionalKey(Schema.String),
  rejected_hint: Schema.optionalKey(Schema.String),
  missing_key_hint: Schema.optionalKey(Schema.String),
});
export type ProxySettings = typeof ProxySettings.Type;

const Accepted = Schema.Struct({ id: Schema.String, reason: Schema.String });

/** A line SecretScan.ts flagged that is not a secret: its file and line hash. */
const AllowedSecret = Schema.Struct({
  file: Schema.String,
  line: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});

const FleetSection = Schema.Struct({
  /** Where every node keeps its clone of this repository. */
  checkout: Schema.optionalKey(Schema.String),
  /** Branch nodes follow. */
  branch: Schema.optionalKey(Schema.String),
  /** Seconds between sync runs. */
  interval: Schema.optionalKey(Schema.Number),
  /** Failures in a row before an alert. */
  alert_after: Schema.optionalKey(Schema.Number),
  /** Areas whose safe fixes sync runs unattended. */
  apply: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Repo paths whose local changes sync commits (authority) or proposes (others). */
  auto_commit: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Path prefixes an authority's sync approves proposals under without review. */
  auto_approve: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** The optional relay (see Relay.ts): where nodes reach it, and the port it listens on locally. */
const RelaySection = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Number),
});

/**
 * The app on the hub (HubUi.ts): the Tailscale logins it opens for. Setup
 * writes the login of the authority that made the hub; none means nobody.
 */
const UiSection = Schema.Struct({
  allow: Schema.optionalKey(Schema.Array(Schema.String)),
});

const FleetFile = Schema.Struct({
  fleet: Schema.optionalKey(FleetSection),
  /** Plugin areas, relative to the config repo (see Plugins.ts). */
  plugins: Schema.optionalKey(
    Schema.Struct({ areas: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  relay: Schema.optionalKey(RelaySection),
  ui: Schema.optionalKey(UiSection),
  proxy: Schema.optionalKey(ProxySettings),
  accept: Schema.optionalKey(Schema.Array(Accepted)),
  allow_secret: Schema.optionalKey(Schema.Array(AllowedSecret)),
  defaults: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type FleetSettings = typeof FleetFile.Type;

export interface Node {
  readonly name: string;
  /** ssh destination; null for the machine T3 Fleet is running on. */
  readonly ssh: string | null;
  readonly roles: ReadonlyArray<Role>;
  readonly profiles: ReadonlyArray<string>;
  /** The node's name on the tailnet, when it has one. */
  readonly tailnet: string | null;
  /** Merged area settings: defaults, then profiles, then the node file. */
  readonly settings: Merged;
}

export interface Config {
  readonly repo: string;
  /** This machine's node name. */
  readonly self: string;
  /** Where nodes keep their clone of the config repo (portable, with ~). */
  readonly checkout: string;
  readonly branch: string;
  readonly interval: number;
  readonly alertAfter: number;
  readonly nodes: ReadonlyArray<Node>;
  readonly settings: FleetSettings;
}

/** Keys of a node file that describe the node rather than its settings. */
const NODE_KEYS = new Set(["ssh", "roles", "profiles", "description", "tailnet"]);

const readTomlTable = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<Table>();
    const raw = yield* Effect.try({
      try: () => parseToml(text.value) as unknown as Table,
      catch: (cause) => new ConfigError({ message: `${file}: ${String(cause).split("\n")[0]}` }),
    });
    return Option.some(raw);
  });

const decodeAs = <S extends Schema.Top>(schema: S, value: unknown, file: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (error) => new ConfigError({ message: `${file}: ${error.message.split("\n")[0]}` }),
    ),
  );

export const NOT_SET_UP = new ConfigError({
  message:
    "this machine is not set up yet: run `t3-fleet setup` to start a fleet here, or `t3-fleet setup <repo-url>` to join one (it shows its plan before changing anything); `t3-fleet doctor` checks this machine first",
});

const StringList = Schema.Array(Schema.String);

/** Load a config repository; `self` names the machine T3 Fleet runs on. */
export const loadConfigFrom = (repo: string, self: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const fleetPath = path.join(repo, FLEET_FILE);
    const fleetRaw = Option.getOrElse(yield* readTomlTable(fleetPath), (): Table => ({}));
    const settings = yield* decodeAs(FleetFile, fleetRaw, fleetPath);

    const profileCache = new Map<string, Table>();
    const profile = (name: string) =>
      Effect.gen(function* () {
        const cached = profileCache.get(name);
        if (cached !== undefined) return cached;
        const file = path.join(repo, "profiles", `${name}.toml`);
        const table = yield* readTomlTable(file);
        if (Option.isNone(table))
          return yield* new ConfigError({ message: `profile "${name}" not found: ${file}` });
        profileCache.set(name, table.value);
        return table.value;
      });

    const nodesDir = path.join(repo, "nodes");
    const files = yield* fs
      .readDirectory(nodesDir)
      .pipe(
        Effect.mapError(
          () => new ConfigError({ message: `no machines: ${nodesDir} does not exist` }),
        ),
      );
    const nodes: Array<Node> = [];
    for (const file of files.filter((f) => f.endsWith(".toml")).sort()) {
      const name = file.slice(0, -".toml".length);
      const nodePath = path.join(nodesDir, file);
      const raw = Option.getOrElse(yield* readTomlTable(nodePath), (): Table => ({}));
      const ssh = typeof raw["ssh"] === "string" ? raw["ssh"] : name;
      const roles = yield* decodeAs(
        Schema.Array(Schema.Literals(ROLES)),
        raw["roles"] ?? ["member"],
        nodePath,
      );
      const profiles = yield* decodeAs(StringList, raw["profiles"] ?? [], nodePath);
      const own: Record<string, Table[string]> = {};
      for (const [k, v] of Object.entries(raw)) if (!NODE_KEYS.has(k)) own[k] = v;
      const layers: Array<Layer> = [
        { source: "defaults", table: (settings.defaults ?? {}) as Table },
      ];
      for (const p of profiles) layers.push({ source: `profile ${p}`, table: yield* profile(p) });
      layers.push({ source: `node ${name}`, table: own });
      const tailnet = typeof raw["tailnet"] === "string" ? raw["tailnet"] : null;
      nodes.push({
        name,
        ssh: name === self ? null : ssh,
        roles,
        profiles,
        tailnet,
        settings: mergeLayers(layers),
      });
    }
    if (nodes.length === 0)
      return yield* new ConfigError({ message: `no machines in ${nodesDir}` });
    if (!nodes.some((n) => n.name === self)) {
      return yield* new ConfigError({
        message: `this machine is "${self}", but ${nodesDir} has no ${self}.toml`,
      });
    }
    return {
      repo,
      self,
      checkout: settings.fleet?.checkout ?? "~/fleet",
      branch: settings.fleet?.branch ?? "main",
      interval: settings.fleet?.interval ?? 900,
      alertAfter: settings.fleet?.alert_after ?? 3,
      nodes,
      settings,
    } satisfies Config;
  });

export const localConfigPath = (home: string) => `${configDir(home)}/config.toml`;

export const loadConfig = Effect.gen(function* () {
  const home = process.env["HOME"] ?? "";
  const local = yield* readTomlTable(localConfigPath(home));
  const decoded = Option.isSome(local)
    ? Option.some(yield* decodeAs(LocalFile, local.value, localConfigPath(home)))
    : Option.none();
  const repoSetting =
    process.env["T3_FLEET_CONFIG_REPO"] ??
    Option.getOrUndefined(Option.map(decoded, (l) => l.repo));
  const self =
    process.env["T3_FLEET_NODE"] ??
    Option.getOrUndefined(Option.flatMap(decoded, (l) => Option.fromNullishOr(l.node)));
  if (repoSetting === undefined || self === undefined) return yield* NOT_SET_UP;
  return yield* loadConfigFrom(expandHome(repoSetting, home), self);
});

/** What the probe needs to know on a machine it runs on, passed as its argument. */
export const ProbeSettings = Schema.Struct({
  proxy: Schema.optionalKey(
    Schema.Struct({
      credentials: Schema.String,
      launchers: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  /** This node's merged area settings. */
  areas: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  /** Where this node keeps the config repo. */
  checkout: Schema.optionalKey(Schema.String),
  /** SHA-256 of the controller's T3 Fleet build. */
  engine: Schema.optionalKey(Schema.String),
  /** Which build that is (Build.ts). */
  build: Schema.optionalKey(BuildId),
  /** The node's name. */
  node: Schema.optionalKey(Schema.String),
  roles: Schema.optionalKey(Schema.Array(Schema.String)),
  plugins: Schema.optionalKey(Schema.Array(Schema.String)),
  relay: Schema.optionalKey(
    Schema.Struct({ url: Schema.NullOr(Schema.String), port: Schema.Number }),
  ),
});
export type ProbeSettings = typeof ProbeSettings.Type;

export const probeSettings = (
  config: Config,
  node?: Node,
  engine?: string,
  build?: BuildId | null,
): ProbeSettings => ({
  ...(engine === undefined ? {} : { engine }),
  ...(build === undefined || build === null ? {} : { build }),
  ...(config.settings.proxy === undefined
    ? {}
    : {
        proxy: {
          credentials: config.settings.proxy.credentials,
          launchers: config.settings.proxy.launchers,
        },
      }),
  ...(node === undefined
    ? {}
    : {
        areas: node.settings.table as Record<string, unknown>,
        node: node.name,
        roles: node.roles,
      }),
  ...(config.settings.relay === undefined
    ? {}
    : {
        relay: { url: config.settings.relay.url ?? null, port: config.settings.relay.port ?? 8399 },
      }),
  // This machine uses the repo it loaded, wherever it is (setup --dir, T3_FLEET_CONFIG_REPO); others their [fleet] checkout.
  checkout: node?.ssh === null ? config.repo : config.checkout,
  ...(config.settings.plugins?.areas === undefined
    ? {}
    : { plugins: config.settings.plugins.areas }),
});
