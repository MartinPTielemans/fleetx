/**
 * The hub's view of the repo's mcp/<name>.json definitions. The same files
 * drive client registration (areas/Mcp.ts); the hub serves every definition
 * with a hosted kind, and there is nothing else to list.
 *
 *   remote        proxied to `url`, with the server's credential added
 *   container     `image` run with Docker; `transport` "streamable-http" (the
 *   registry      default for container) is proxied, "stdio" (the default for
 *                 registry) is bridged
 *   hosted-stdio  `command` with `args` run on the relay node and bridged
 *
 * Fields beyond the kind's own, all optional:
 *
 *   auth = { type = "bearer", token_env = "NAME" }   a secret sent as the bearer
 *   remote_auth = true                               OAuth (also detected from a 401)
 *   remote_auth_scopes = ["…"]                       scopes to ask for
 *   oauth = { client_id = "…", client_secret_env = "NAME" }
 *                                                    a static client, for servers
 *                                                    without dynamic registration
 *   env = { KEY = "$SECRET" }                        container or command environment;
 *                                                    $NAME / ${NAME} read the fleet's secrets
 *   network = "none"                                 no network (stdio images only)
 *   target_port = 8080, path = "/mcp"                where an HTTP image listens
 *   tools = { deny = ["delete_*"] }                  tools no client may call
 *
 * Files written for ToolHive keep working: its own fields (callback ports,
 * timeouts, registry references) are ignored.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseJson } from "./JsonRpc.ts";

export const HOSTED_KINDS: ReadonlyArray<string> = ["remote", "container", "registry", "hosted-stdio"];

export const isHosted = (kind: string) => HOSTED_KINDS.includes(kind);

const RawDefinition = Schema.Struct({
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
  image: Schema.optionalKey(Schema.String),
  transport: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  network: Schema.optionalKey(Schema.String),
  target_port: Schema.optionalKey(Schema.Number),
  path: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(Schema.Struct({ type: Schema.String, token_env: Schema.optionalKey(Schema.String) })),
  remote_auth: Schema.optionalKey(Schema.Boolean),
  remote_auth_scopes: Schema.optionalKey(Schema.Array(Schema.String)),
  oauth: Schema.optionalKey(
    Schema.Struct({ client_id: Schema.String, client_secret_env: Schema.optionalKey(Schema.String), scopes: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  tools: Schema.optionalKey(Schema.Struct({ deny: Schema.optionalKey(Schema.Array(Schema.String)) })),
});

export type HubRunner =
  | { readonly type: "remote"; readonly url: string }
  | {
      readonly type: "docker-http";
      readonly image: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly targetPort: number;
      readonly path: string;
    }
  | {
      readonly type: "docker-stdio";
      readonly image: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly network: "none" | null;
    }
  | { readonly type: "command"; readonly command: string; readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }
  /** A server already listening on a local port: the gateway without the hub (`[mcp] ports`). */
  | { readonly type: "port"; readonly port: number };

export type HubAuth =
  | { readonly type: "none" }
  | { readonly type: "bearer"; readonly tokenEnv: string }
  | {
      readonly type: "oauth";
      readonly scopes: ReadonlyArray<string>;
      readonly client: { readonly clientId: string; readonly clientSecretEnv: string | null } | null;
    };

export interface HubDefinition {
  readonly name: string;
  readonly kind: string;
  readonly runner: HubRunner;
  readonly auth: HubAuth;
  /** Glob patterns of tools no client may call. */
  readonly deny: ReadonlyArray<string>;
  /** For display: the remote URL, the image, or the command. */
  readonly upstream: string;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const decodeRaw = Schema.decodeUnknownOption(RawDefinition);

/** One definition, or why the hub cannot serve it. Pure, so the area and tests share it. */
export const parseDefinition = (name: string, text: string): HubDefinition | { readonly problem: string } => {
  if (!NAME_PATTERN.test(name)) return { problem: `${name} is not a valid server name` };
  const raw = decodeRaw(parseJson(text));
  if (raw._tag === "None") return { problem: `mcp/${name}.json is not a valid definition` };
  const d = raw.value;
  if (!isHosted(d.kind)) return { problem: `kind ${d.kind} is not hosted` };
  const env = d.env ?? {};
  const deny = d.tools?.deny ?? [];
  const bearer = d.auth?.type === "bearer" && d.auth.token_env !== undefined ? d.auth.token_env : null;
  const auth: HubAuth =
    bearer !== null
      ? { type: "bearer", tokenEnv: bearer }
      : d.remote_auth === true || d.oauth !== undefined
        ? {
            type: "oauth",
            scopes: d.remote_auth_scopes ?? d.oauth?.scopes ?? [],
            client: d.oauth === undefined ? null : { clientId: d.oauth.client_id, clientSecretEnv: d.oauth.client_secret_env ?? null },
          }
        : { type: "none" };
  const base = { name, kind: d.kind, auth, deny };
  switch (d.kind) {
    case "remote": {
      if (d.url === undefined) return { problem: "remote definition has no url" };
      if (!/^https?:\/\//.test(d.url)) return { problem: `remote url must be http(s): ${d.url}` };
      return { ...base, runner: { type: "remote", url: d.url }, upstream: d.url };
    }
    case "hosted-stdio": {
      if (d.command === undefined) return { problem: "hosted-stdio definition has no command" };
      const args = d.args ?? [];
      return { ...base, runner: { type: "command", command: d.command, args, env }, upstream: [d.command, ...args].join(" ") };
    }
    default: {
      if (d.image === undefined) return { problem: `${d.kind} definition has no image` };
      const transport = d.transport ?? (d.kind === "registry" ? "stdio" : "streamable-http");
      const args = d.args ?? [];
      if (d.network !== undefined && d.network !== "none") return { problem: `network must be "none" when set, not ${d.network}` };
      if (transport === "stdio") {
        return { ...base, runner: { type: "docker-stdio", image: d.image, args, env, network: d.network === "none" ? "none" : null }, upstream: d.image };
      }
      if (transport !== "streamable-http") return { problem: `transport ${transport} is not supported; use streamable-http or stdio` };
      if (d.network === "none") return { problem: `network = "none" needs transport = "stdio": an HTTP image must be reachable` };
      return {
        ...base,
        runner: { type: "docker-http", image: d.image, args, env, targetPort: d.target_port ?? 8080, path: d.path ?? "/mcp" },
        upstream: d.image,
      };
    }
  }
};

export const isProblem = (d: HubDefinition | { readonly problem: string }): d is { readonly problem: string } => "problem" in d;

/** A server listening on a local port, served by the gateway without the hub. */
export const portDefinition = (name: string, port: number): HubDefinition => ({
  name,
  kind: "port",
  runner: { type: "port", port },
  auth: { type: "none" },
  deny: [],
  upstream: `127.0.0.1:${port}`,
});

/** Every hosted definition in the repo's mcp/, and the files the hub cannot serve. */
export const loadDefinitions = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(repo, "mcp");
    const files = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const definitions: Array<HubDefinition> = [];
    const problems: Array<{ readonly name: string; readonly problem: string }> = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const name = file.slice(0, -".json".length);
      const text = yield* fs.readFileString(path.join(dir, file)).pipe(Effect.orElseSucceed(() => ""));
      const kind = (parseJson(text) as { kind?: unknown } | undefined)?.kind;
      if (typeof kind !== "string" || !isHosted(kind)) continue;
      const parsed = parseDefinition(name, text);
      if (isProblem(parsed)) problems.push({ name, problem: parsed.problem });
      else definitions.push(parsed);
    }
    return { definitions, problems };
  });

/** Expand $NAME and ${NAME} from the fleet's secrets; unknown names expand to "". */
export const expandSecrets = (value: string, secrets: Readonly<Record<string, string>>) =>
  value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, a: string | undefined, b: string | undefined) => secrets[a ?? b ?? ""] ?? "");

/** A definition's environment with secrets filled in. */
export const resolvedEnv = (env: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandSecrets(v, secrets)]));
