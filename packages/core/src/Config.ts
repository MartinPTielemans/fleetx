/**
 * Where a user's setup lives, and what it says.
 *
 * The engine knows nothing about anyone's machines. Each machine has one
 * small local file, ~/.config/fleetx/config.toml, naming the user's private
 * config repository and which node this machine is:
 *
 *   repo = "~/Projects/fleet"
 *   node = "laptop"
 *
 * The repository holds the setup itself:
 *
 *   fleetx.toml        settings for the whole fleet (proxy, accepted differences)
 *   nodes/<name>.toml  one file per machine: how to reach it
 *
 * FLEETX_CONFIG_REPO and FLEETX_NODE override the local file, for tests and
 * one-off runs.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

/** `~/x` → `<home>/x`. Config paths stay portable across machines. */
export const expandHome = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path);

const LocalFile = Schema.Struct({ repo: Schema.String, node: Schema.optionalKey(Schema.String) });

const NodeFile = Schema.Struct({
  /** ssh destination; omitted means the node's own name. */
  ssh: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});

/**
 * A model proxy that providers can be routed through: a launcher per T3
 * provider instance that starts the agent CLI against the proxy, and the
 * per-machine credentials file ({"endpoint": "...", "api_key": "..."}, an
 * OpenAI-compatible base URL) the proxy check uses.
 */
const ProxySettings = Schema.Struct({
  credentials: Schema.String,
  launchers: Schema.Record(Schema.String, Schema.String),
  /** Command that points T3's provider at its launcher; `{provider}` is the instance id. */
  enable: Schema.optionalKey(Schema.String),
  /** What to do when the proxy refuses a machine's key. */
  rejected_hint: Schema.optionalKey(Schema.String),
  /** What to do when a machine has no key yet. */
  missing_key_hint: Schema.optionalKey(Schema.String),
});
export type ProxySettings = typeof ProxySettings.Type;

const Accepted = Schema.Struct({ id: Schema.String, reason: Schema.String });

const FleetFile = Schema.Struct({
  proxy: Schema.optionalKey(ProxySettings),
  accept: Schema.optionalKey(Schema.Array(Accepted)),
});
export type FleetSettings = typeof FleetFile.Type;

export interface Node {
  readonly name: string;
  /** ssh destination; null for the machine fleetx is running on. */
  readonly ssh: string | null;
}

export interface Config {
  readonly repo: string;
  /** This machine's node name. */
  readonly self: string;
  readonly nodes: ReadonlyArray<Node>;
  readonly settings: FleetSettings;
}

const readToml = <S extends Schema.Top>(schema: S, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<S["Type"]>();
    const raw: unknown = yield* Effect.try({
      try: () => parseToml(text.value),
      catch: (cause) => new ConfigError({ message: `${file}: ${String(cause).split("\n")[0]}` }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError((error) => new ConfigError({ message: `${file}: ${error.message.split("\n")[0]}` })),
    );
    return Option.some<S["Type"]>(decoded);
  });

const NOT_SET_UP = new ConfigError({
  message: "this machine is not set up: write ~/.config/fleetx/config.toml with repo = \"<path to your config repo>\" and node = \"<this machine's name>\"",
});

export const loadConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = process.env["HOME"] ?? "";
  const local = yield* readToml(LocalFile, path.join(home, ".config/fleetx/config.toml"));
  const repoSetting = process.env["FLEETX_CONFIG_REPO"] ?? Option.getOrUndefined(Option.map(local, (l) => l.repo));
  if (repoSetting === undefined) return yield* NOT_SET_UP;
  const repo = expandHome(repoSetting, home);
  const self = process.env["FLEETX_NODE"] ?? Option.getOrUndefined(Option.flatMap(local, (l) => Option.fromNullishOr(l.node)));
  if (self === undefined) return yield* NOT_SET_UP;

  const nodesDir = path.join(repo, "nodes");
  const files = yield* fs.readDirectory(nodesDir).pipe(
    Effect.mapError(() => new ConfigError({ message: `no machines: ${nodesDir} does not exist` })),
  );
  const nodes: Array<Node> = [];
  for (const file of files.filter((f) => f.endsWith(".toml")).sort()) {
    const name = file.slice(0, -".toml".length);
    const node = yield* readToml(NodeFile, path.join(nodesDir, file));
    const ssh = Option.getOrUndefined(Option.flatMap(node, (n) => Option.fromNullishOr(n.ssh))) ?? name;
    nodes.push({ name, ssh: name === self ? null : ssh });
  }
  if (nodes.length === 0) return yield* new ConfigError({ message: `no machines in ${nodesDir}` });
  if (!nodes.some((n) => n.name === self)) {
    return yield* new ConfigError({ message: `this machine is "${self}", but ${nodesDir} has no ${self}.toml` });
  }
  const settings = Option.getOrElse(yield* readToml(FleetFile, path.join(repo, "fleetx.toml")), (): FleetSettings => ({}));
  return { repo, self, nodes, settings } satisfies Config;
});

/** What the probe needs to know on a machine it runs on, passed as its argument. */
export const ProbeSettings = Schema.Struct({
  proxy: Schema.optionalKey(Schema.Struct({ credentials: Schema.String, launchers: Schema.Record(Schema.String, Schema.String) })),
});
export type ProbeSettings = typeof ProbeSettings.Type;

export const probeSettings = (config: Config): ProbeSettings =>
  config.settings.proxy === undefined
    ? {}
    : { proxy: { credentials: config.settings.proxy.credentials, launchers: config.settings.proxy.launchers } };
