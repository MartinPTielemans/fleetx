/**
 * MCP servers: declared once in the repo's mcp/<name>.json, registered in
 * every agent client on the nodes that list them, and checked live.
 *
 *   [mcp]
 *   servers = ["fetch", "executor"]     # which to register on this node
 *   ignore = ["node_repl"]              # this machine's own servers, left alone
 *   hub = true                          # the relay's MCP hub serves hosted kinds
 *   gateway = "https://relay.tailnet.ts.net:8399"   # the relay, for hosted servers
 *   token_env = "T3_FLEET_MCP_TOKEN_LAPTOP"   # optional: a client token
 *                                             # instead of the relay token
 *
 * Without the hub, hosted servers run elsewhere (ToolHive, say):
 *
 *   origin = "server.tailnet.ts.net"    # host serving hosted servers
 *   ports = { fetch = 18100 }           # hosted server → port on the origin
 *   gateway = "…"                       # optional: through the relay's gateway
 *
 * A definition's `kind` decides where clients connect:
 *
 *   stdio     run `command` with `args` on the node itself
 *   direct    connect to `url`
 *   remote, container, registry, hosted-stdio
 *             hosted: with the hub, clients connect to <gateway>/mcp/<name>;
 *             without it, to http://<origin>:<port>/mcp (or the gateway when
 *             a port is listed), with no proxy on the node
 *
 * With the hub on, the relay node also reports servers that need a sign-in,
 * and every node reports ToolHive workloads still running servers the hub
 * now serves.
 *
 * `auth = { type = "bearer", token_env = "NAME" }` sends the named secret as a
 * bearer token. Codex reads it from the environment at run time; Claude stores
 * the header, so its fix loads the node's secrets first.
 *
 * A stdio server's `env = { KEY = "value" }` and a direct server's
 * `headers = { "Header-Name" = "value" }` go with the registration; a value
 * that is exactly `$NAME` is the fleet secret NAME, anything else is literal.
 * Claude stores the secret's value; Codex is told the variable's name
 * (`env_vars`, `env_http_headers`) and reads it from its environment. A
 * credential only a url or an argument can carry is written into it as
 * `$NAME` (`?apiKey=$KEY`, `--api-key $KEY`): Claude gets the value, Codex a
 * shell that fills it into the arguments. Claude's fix runs
 * `t3-fleet mcp register-claude`, which reads the secrets itself, so no value
 * is ever on a command line. A direct server with
 * `transport = "sse"`, or with a secret in its url, gets no registration in
 * Codex, which has no SSE transport and no way to fill a variable into a url.
 *
 * A registration is compared with the definition on the node, and only the
 * names of what differs are published: a registered url or argument can
 * hold a credential.
 *
 * Every node also reports servers its clients have that its [mcp] servers do
 * not list, so a machine's own servers are not silently left out of the fleet.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { parse as parseToml } from "smol-toml";

import { defineArea, sh, shPath } from "../Area.ts";
import {
  claudeConfigBackups,
  claudeConfigPath,
  holdsAny,
  readClaudeConfig,
  updateClaudeConfig,
  type ClaudeConfig,
} from "../ClaudeConfig.ts";
import { expandHome } from "../Config.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { isHosted } from "../hub/Definitions.ts";
import { configDir, header } from "../Names.ts";

const Desired = Schema.UndefinedOr(
  Schema.Struct({
    servers: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Servers this machine's clients have that the fleet leaves alone, unreported. */
    ignore: Schema.optionalKey(Schema.Array(Schema.String)),
    hub: Schema.optionalKey(Schema.Boolean),
    origin: Schema.optionalKey(Schema.String),
    ports: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
    gateway: Schema.optionalKey(Schema.String),
    token_env: Schema.optionalKey(Schema.String),
  }),
);
export type McpDesired = typeof Desired.Type;

/** Environment variables or headers: a literal value, or `$NAME` for the fleet secret NAME. */
const Values = Schema.Record(Schema.String, Schema.String);

const Definition = Schema.Struct({
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Values),
  headers: Schema.optionalKey(Values),
  transport: Schema.optionalKey(Schema.String),
  auth: Schema.optionalKey(
    Schema.Struct({ type: Schema.String, token_env: Schema.optionalKey(Schema.String) }),
  ),
});

/** Where a client should reach a server, with what it sends. */
export const Endpoint = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    url: Schema.String,
    tokenEnv: Schema.NullOr(Schema.String),
    headers: Schema.optionalKey(Values),
    transport: Schema.optionalKey(Schema.Literal("sse")),
  }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.optionalKey(Values),
  }),
]);
export type Endpoint = typeof Endpoint.Type;
type StdioEndpoint = Extract<Endpoint, { readonly type: "stdio" }>;

/** The secret a value refers to: NAME when it is exactly `$NAME`, else null (a literal). */
export const secretRef = (value: string) => /^\$([A-Z_][A-Z0-9_]*)$/.exec(value)?.[1] ?? null;

/** `$NAME` and `${NAME}` inside a url, command or argument: what the shell expands there (see dq). */
const EMBEDDED = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g;

/** The variables a url, command or argument names, such as a secret in a query string. */
export const embeddedRefs = (text: string) =>
  [...text.matchAll(EMBEDDED)].map((m) => m[1] ?? m[2] ?? "");

/** Text with its variables filled in as the shell would: an unknown one is empty. */
const expandEmbedded = (text: string, value: (name: string) => string | undefined) =>
  text.replace(
    EMBEDDED,
    (_, a: string | undefined, b: string | undefined) => value(a ?? b ?? "") ?? "",
  );

/**
 * How Codex runs a stdio server. It passes variables of its own environment
 * through by name (`env_vars`) and keeps only literals in config.toml (`env`).
 * A secret the server expects under another name, or one inside an argument
 * (`--api-key $KEY`), needs a shell that fills it in and then runs the server.
 * That shell first copies every variable it reads, refusing on stderr when one
 * is not set, and only then sets the server's, literals included: no variable
 * overwrites another's source.
 */
export const codexStdio = (e: StdioEndpoint) => {
  const literal: Record<string, string> = {};
  const vars: Array<string> = [];
  const pass = (name: string) => {
    if (!vars.includes(name)) vars.push(name);
  };
  let renamed = false;
  for (const [key, value] of Object.entries(e.env ?? {})) {
    const ref = secretRef(value);
    if (ref === null) literal[key] = value;
    else {
      pass(ref);
      if (ref !== key) renamed = true;
    }
  }
  const words = [e.command, ...e.args];
  const embedded = words.flatMap(embeddedRefs);
  for (const name of embedded) pass(name);
  if (!renamed && embedded.length === 0)
    return { command: e.command, args: e.args, env: literal, vars };
  // Copies under a prefix no source or destination name starts with.
  const names = [...Object.keys(e.env ?? {}), ...vars];
  let prefix = "_t3f_";
  while (names.some((n) => n.startsWith(prefix))) prefix = `_${prefix}`;
  const copy = (name: string) => `${prefix}${vars.indexOf(name)}`;
  const script = [
    ...vars.map(
      (n) =>
        `[ -n "\${${n}+x}" ] || { echo ${sh(`t3-fleet: ${n} is not set in Codex's environment`)} >&2; exit 1; }`,
    ),
    ...vars.map((n) => `${copy(n)}="$${n}"`),
    ...Object.entries(e.env ?? {}).map(([key, value]) => {
      const ref = secretRef(value);
      return `export ${key}=${ref === null ? sh(value) : `"$${copy(ref)}"`}`;
    }),
    `exec ${words
      .map((w) =>
        dq(
          w.replace(
            EMBEDDED,
            (_, a: string | undefined, b: string | undefined) => `\${${copy(a ?? b ?? "")}}`,
          ),
        ),
      )
      .join(" ")}`,
  ].join("; ");
  return { command: "sh", args: ["-c", script], env: {}, vars };
};

/** Claude's entry for a server: what `register-claude` writes and the probe compares with. */
export interface ClaudeEntry {
  readonly type: string;
  readonly url?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Claude's entry for an endpoint, with values: secrets and variables filled
 * in from `value` (the node's secrets, then its environment). `missing` names
 * those it does not have, filled in as empty.
 */
export const claudeEntry = (e: Endpoint, value: (name: string) => string | undefined) => {
  const missing = new Set<string>();
  const used = new Set<string>();
  const get = (name: string) => {
    used.add(name);
    const v = value(name);
    if (v === undefined) missing.add(name);
    return v ?? "";
  };
  const fill = (text: string) =>
    text.replace(EMBEDDED, (_, a: string | undefined, b: string | undefined) => get(a ?? b ?? ""));
  const values = (vs: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(vs).map(([key, v]) => {
        const ref = secretRef(v);
        return [key, ref === null ? v : get(ref)];
      }),
    );
  let entry: ClaudeEntry;
  if (e.type === "http") {
    const headers = {
      ...(e.tokenEnv === null ? {} : { Authorization: `Bearer ${get(e.tokenEnv)}` }),
      ...values(e.headers ?? {}),
    };
    entry = {
      type: e.transport ?? "http",
      url: fill(e.url),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  } else {
    entry = {
      type: "stdio",
      command: fill(e.command),
      args: e.args.map(fill),
      ...(e.env === undefined ? {} : { env: values(e.env) }),
    };
  }
  return { entry, missing: [...missing].sort(), used: [...used].sort() };
};

/**
 * What a client has registered under a name, compared on the node with what
 * it should have. `differs` names what is not as declared (`url`, `command`,
 * `args`, an env variable or header); `kept`, settings it has that the
 * definition does not (an env variable or header it does not declare, Codex's
 * per-server options). Names only, never values: observations are published,
 * and a registered url or argument can hold a credential.
 */
const Registered = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    /** Only older nodes publish it; compared when present. */
    url: Schema.optionalKey(Schema.String),
    /** These three too: whether it sends a bearer token, the declared one, over SSE. */
    auth: Schema.optionalKey(Schema.Boolean),
    credential: Schema.optionalKey(Schema.Boolean),
    transport: Schema.optionalKey(Schema.Literal("sse")),
    differs: Schema.optionalKey(Schema.Array(Schema.String)),
    kept: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("stdio"),
    /** Only older nodes publish it; compared when present. */
    command: Schema.optionalKey(Schema.String),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    differs: Schema.optionalKey(Schema.Array(Schema.String)),
    kept: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("other"),
    kept: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);

/**
 * Settings of a client's entry that re-registering from a definition would
 * drop: everything but the fields T3 Fleet writes, and empty or default
 * values. In the tables named by `declared` (env, headers), only the entries
 * the replacement does not write.
 */
export const keptSettings = (
  entry: Readonly<Record<string, unknown>>,
  writes: ReadonlyArray<string>,
  declared: Readonly<Record<string, ReadonlyArray<string>>> = {},
): Array<string> => {
  const kept: Array<string> = [];
  for (const [key, value] of Object.entries(entry)) {
    if (
      writes.includes(key) ||
      value === undefined ||
      value === null ||
      (key === "enabled" && value === true)
    )
      continue;
    const label = TABLE_LABELS[key];
    if (label !== undefined && typeof value === "object") {
      const names = Array.isArray(value)
        ? value.map((v: unknown) =>
            typeof v === "string" ? v : String((v as { name?: unknown } | null)?.name),
          )
        : Object.keys(value);
      const known = declared[key] ?? [];
      for (const name of names) if (!known.includes(name)) kept.push(`${label} ${name}`);
      continue;
    }
    if (typeof value === "object" && Object.keys(value).length === 0) continue;
    kept.push(key);
  }
  return kept;
};
/** Tables kept entry by entry, and what an entry is called. */
const TABLE_LABELS: Readonly<Record<string, string>> = {
  env: "env",
  headers: "header",
  env_vars: "env_vars",
  http_headers: "header",
  env_http_headers: "header",
};
const CLAUDE_WRITES = ["type", "url", "command", "args"];
const CODEX_WRITES = ["url", "command", "args"];
type Registered = typeof Registered.Type;

const Observed = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /** Null when the definition is missing or cannot be resolved. */
      endpoint: Schema.NullOr(Endpoint),
      problem: Schema.NullOr(Schema.String),
      claude: Schema.NullOr(Registered),
      codex: Schema.NullOr(Registered),
      /** Live check of an http endpoint: "ok", or what went wrong; null if not checked. */
      live: Schema.NullOr(Schema.String),
      /** Secrets its env or headers refer to that this node has neither in its secrets nor its environment. */
      missing: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  clients: Schema.Struct({ claude: Schema.Boolean, codex: Schema.Boolean }),
  /**
   * Claude's config and its backups (`~`-relative paths) that hold one of
   * this node's secrets while others can read them.
   */
  exposed: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Some of Claude's config files could not be looked into: too many, too large, too slow. */
  unchecked: Schema.optionalKey(Schema.Boolean),
  /** User-scope servers each client has that [mcp] servers does not list. */
  undeclared: Schema.optionalKey(
    Schema.Struct({ claude: Schema.Array(Schema.String), codex: Schema.Array(Schema.String) }),
  ),
  /** Relay node with the hub on: each hosted server's state, as the hub reports it; null if unknown. */
  hub: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          state: Schema.String,
          detail: Schema.NullOr(Schema.String),
        }),
      ),
    ),
  ),
  /** Hub on: ToolHive workloads still running servers the hub serves. */
  toolhive: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeJsonRaw = Schema.Struct({
  mcpServers: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  ),
});

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t3-fleet", version: "1" },
  },
});

/**
 * The variables of a secrets.env file, by name, as the shell reads them when
 * it sources the file: a double-quoted value may span lines (Secrets.setVar
 * writes a value's newlines as they are) and a backslash escapes only `$`,
 * a backquote, `"`, `\` and a newline; a single-quoted value is taken as it
 * is; an unquoted one runs to the end of the line.
 */
export const parseSecrets = (text: string) => {
  const secrets: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    const eol = text.indexOf("\n", at) === -1 ? text.length : text.indexOf("\n", at);
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/.exec(text.slice(at, eol));
    if (m?.[1] === undefined) {
      at = eol + 1;
      continue;
    }
    let i = at + m[0].length;
    let value = "";
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      for (i++; i < text.length && text[i] !== quote; i++) {
        const next = text[i + 1];
        if (quote === '"' && text[i] === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
          if (next !== "\n") value += next;
          i++;
        } else value += text[i];
      }
      const rest = text.indexOf("\n", i);
      at = rest === -1 ? text.length : rest + 1;
    } else {
      value = text.slice(i, eol);
      at = eol + 1;
    }
    secrets[m[1]] = value;
  }
  return secrets;
};

/** The hub's gateway names a server's state in this header when it cannot serve it. */
const NEEDS_LOGIN = "needs-login";

/**
 * Where clients should reach a server, from its definition and the node's
 * [mcp] settings; or why it cannot be resolved.
 */
export const resolveEndpoint = (
  name: string,
  d: typeof Definition.Type,
  desired: McpDesired,
  home: string,
):
  | { readonly endpoint: Endpoint; readonly problem: null }
  | { readonly endpoint: null; readonly problem: string } => {
  const resolved = resolveUnchecked(name, d, desired, home);
  const problem = resolved.endpoint === null ? null : endpointProblem(resolved.endpoint);
  return problem === null ? resolved : { endpoint: null, problem };
};

/**
 * Why an endpoint cannot be registered as it is, or null. Definitions pass
 * it when they resolve, and `register-claude` checks what it is handed.
 */
export const endpointProblem = (e: Endpoint): string | null => {
  if (e.type === "stdio") {
    const bad = Object.keys(e.env ?? {}).find((k) => !VARIABLE.test(k));
    return bad === undefined ? null : `env ${JSON.stringify(bad)} is not a variable name`;
  }
  // The variable's name goes into fix commands unquoted; only a plain name may.
  if (e.tokenEnv !== null && !ENV_NAME.test(e.tokenEnv))
    return `token_env ${JSON.stringify(e.tokenEnv)} is not a variable name (A-Z, 0-9, _)`;
  const headers = Object.keys(e.headers ?? {});
  const bad = headers.find((h) => !HEADER_NAME.test(h));
  if (bad !== undefined) return `header ${JSON.stringify(bad)} is not a header name`;
  if (e.tokenEnv !== null && headers.some((h) => h.toLowerCase() === "authorization"))
    return "auth and an Authorization header both set the credential; keep one";
  return null;
};

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Variables a url or argument may name that are no secret: their values are everywhere. */
const PLAIN_ENV = new Set(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "PWD", "TMPDIR", "LANG"]);

/** A key a stdio server's env may set (lower case too: it is never left unquoted). */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The relay token's variable, for clients that name none. */
export const RELAY_TOKEN_ENV = "T3_FLEET_RELAY_TOKEN";

const resolveUnchecked = (
  name: string,
  d: typeof Definition.Type,
  desired: McpDesired,
  home: string,
):
  | { readonly endpoint: Endpoint; readonly problem: null }
  | { readonly endpoint: null; readonly problem: string } => {
  const tokenEnv = d.auth?.type === "bearer" ? (d.auth.token_env ?? null) : null;
  const fail = (problem: string) => ({ endpoint: null, problem }) as const;
  const ok = (endpoint: Endpoint) => ({ endpoint, problem: null }) as const;
  if (d.kind === "stdio") {
    if (d.command === undefined) return fail("stdio definition has no command");
    if (d.headers !== undefined) return fail("headers are for direct servers; stdio has env");
    return ok({
      type: "stdio",
      command: expandHome(d.command, home),
      args: (d.args ?? []).map((a) => expandHome(a, home)),
      ...(d.env === undefined || Object.keys(d.env).length === 0 ? {} : { env: d.env }),
    });
  }
  if (d.kind === "direct") {
    if (d.url === undefined) return fail("direct definition has no url");
    if (d.env !== undefined) return fail("env is for stdio servers; direct has headers");
    if (d.transport !== undefined && d.transport !== "sse" && d.transport !== "streamable-http")
      return fail(`transport ${d.transport} is not supported; use sse or leave it out`);
    return ok({
      type: "http",
      url: d.url,
      tokenEnv,
      ...(d.headers === undefined || Object.keys(d.headers).length === 0
        ? {}
        : { headers: d.headers }),
      ...(d.transport === "sse" ? { transport: "sse" as const } : {}),
    });
  }
  const gateway = desired?.gateway?.replace(/\/+$/, "");
  const port = desired?.ports?.[name];
  if (desired?.hub === true) {
    if (!isHosted(d.kind)) return fail(`unknown kind ${d.kind}`);
    // The hub serves every hosted definition; clients authenticate to the gateway, never upstream.
    if (gateway === undefined)
      return fail("[mcp] hub = true, but no [mcp] gateway (the relay's URL)");
    return ok({
      type: "http",
      url: `${gateway}/mcp/${name}`,
      tokenEnv: desired.token_env ?? RELAY_TOKEN_ENV,
    });
  }
  if (gateway !== undefined && port !== undefined) {
    // Through the relay: one endpoint, one token, for every hosted server.
    return ok({
      type: "http",
      url: `${gateway}/mcp/${name}`,
      tokenEnv: desired?.token_env ?? RELAY_TOKEN_ENV,
    });
  }
  if (desired?.origin === undefined || port === undefined)
    return fail(`hosted server, but no [mcp] origin and port for ${name} (or [mcp] hub = true)`);
  return ok({ type: "http", url: `http://${desired.origin}:${port}/mcp`, tokenEnv });
};

/**
 * Register a server in Claude at user scope, for `t3-fleet mcp register-claude`,
 * which fixes run. The secrets are read here, from the node's secrets and then
 * the environment, so no value passes through a command line. Only this one
 * entry of Claude's config is replaced, under Claude's own lock (see
 * ClaudeConfig.ts); nothing changes when any step fails.
 */
export const registerInClaude = (
  home: string,
  name: string,
  endpoint: Endpoint,
  env: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const secrets = parseSecrets(
      yield* fs
        .readFileString(path.join(configDir(home), "secrets.env"))
        .pipe(Effect.orElseSucceed(() => "")),
    );
    const { entry, missing, used } = claudeEntry(endpoint, (n) => secrets[n] ?? env[n]);
    if (missing.length > 0)
      return yield* Effect.fail(
        `${name} needs ${missing.join(", ")}, which this machine's secrets do not have`,
      );
    return yield* updateClaudeConfig(
      home,
      env,
      (config) => {
        const servers = config["mcpServers"];
        return {
          ...config,
          mcpServers: {
            ...(typeof servers === "object" && servers !== null && !Array.isArray(servers)
              ? servers
              : {}),
            [name]: entry,
          },
        };
      },
      { secret: used.length > 0 },
    );
  });

/**
 * An initialize request: what any client does first. No tool is called. The
 * session it opens is deleted again, as every probe on every node runs this.
 * An SSE server is checked by opening its event stream, closed again as soon
 * as it answers. `headers` are the declared ones, secrets filled in.
 */
export const liveCheck = (
  url: string,
  token: string | undefined,
  options: { readonly headers?: Readonly<Record<string, string>>; readonly sse?: boolean } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const authorized = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClientRequest.setHeaders(
        token ? HttpClientRequest.bearerToken(request, token) : request,
        options.headers ?? {},
      );
    if (options.sse === true) {
      const opened = yield* HttpClient.withScope(client)
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader("accept", "text/event-stream"),
            authorized,
          ),
        )
        .pipe(
          Effect.map((r) =>
            r.headers[header("hub-state")] === NEEDS_LOGIN
              ? NEEDS_LOGIN
              : r.status >= 200 && r.status < 300
                ? "ok"
                : `HTTP ${r.status}`,
          ),
          Effect.scoped,
          Effect.timeout(Duration.seconds(8)),
          Effect.option,
        );
      return Option.getOrElse(opened, () => "no answer within 8s");
    }
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }),
      HttpClientRequest.bodyText(INITIALIZE, "application/json"),
      authorized,
    );
    const result = yield* client.execute(request).pipe(
      Effect.flatMap((r) =>
        Effect.gen(function* () {
          const session = r.headers["mcp-session-id"];
          if (session !== undefined) {
            const close = HttpClientRequest.delete(url).pipe(
              HttpClientRequest.setHeader("mcp-session-id", session),
              authorized,
            );
            yield* client.execute(close).pipe(
              Effect.flatMap((d) => d.text),
              Effect.ignore,
            );
          }
          if (r.headers[header("hub-state")] === NEEDS_LOGIN) return NEEDS_LOGIN;
          if (r.status >= 200 && r.status < 300) return "ok";
          return `HTTP ${r.status}: ${(yield* r.text).trim().slice(0, 80)}`;
        }),
      ),
      Effect.timeout(Duration.seconds(8)),
      Effect.option,
    );
    return Option.getOrElse(result, () => "no answer within 8s");
  });

const HubStates = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    state: Schema.String,
    detail: Schema.NullOr(Schema.String),
  }),
);

/** The hub's view of its servers, from the relay on this node; null when it does not answer. */
const hubStates = (port: number, token: string) =>
  Effect.gen(function* () {
    if (token === "") return null;
    const client = yield* HttpClient.HttpClient;
    const text = yield* client
      .execute(
        HttpClientRequest.get(`http://127.0.0.1:${port}/hub/servers`).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(
        Effect.flatMap((r) =>
          r.status === 200 ? r.text.pipe(Effect.asSome) : Effect.succeed(Option.none<string>()),
        ),
        Effect.timeout(Duration.seconds(8)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    if (Option.isNone(text)) return null;
    return Option.getOrNull(Schema.decodeOption(Schema.fromJsonString(HubStates))(text.value));
  });

/** Names of running workloads in `thv list --format json` output (an array, or null when there are none). */
export const toolhiveWorkloads = (text: string): Array<string> => {
  const value = Option.getOrUndefined(
    Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text.trim() === "" ? "null" : text),
  );
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (w): w is { name: string; status?: unknown } =>
        typeof w === "object" && w !== null && typeof (w as { name?: unknown }).name === "string",
    )
    .filter((w) => w.status === undefined || w.status === "running")
    .map((w) => w.name);
};

/**
 * Double-quote for the shell, leaving only plain `$NAME` and `${NAME}`
 * references active: every other `$` (a `$(…)`, `$((…))`, `${x:-…}`) is
 * escaped, as are backticks, quotes and backslashes, so a definition's url,
 * command or args can name a variable and nothing more.
 */
export const dq = (text: string) =>
  `"${text.replace(/[\\"`]/g, "\\$&").replace(/\$(?![A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g, "\\$$")}"`;

const sameEndpoint = (want: Endpoint, got: Registered | null, client: "claude" | "codex") => {
  if (got === null || got.type !== want.type || (got.differs?.length ?? 0) > 0) return false;
  // Older nodes publish the registered url, command and args, and leave the comparison to this.
  if (want.type === "http" && got.type === "http" && got.url !== undefined)
    return (
      got.url === want.url &&
      got.auth === (want.tokenEnv !== null) &&
      got.credential !== false &&
      (client === "codex" || got.transport === want.transport)
    );
  if (want.type === "stdio" && got.type === "stdio" && got.command !== undefined) {
    const run = client === "codex" ? codexStdio(want) : want;
    return got.command === run.command && JSON.stringify(got.args) === JSON.stringify(run.args);
  }
  return true;
};

/** A path for a fix: the node's own home, whoever's home it was observed in. */
const homeVar = (p: string) =>
  p.replace(/^\/(Users|home)\/[^/]+\//, "$HOME/").replace(/^\/root\//, "$HOME/");

/**
 * Claude's registration, by `t3-fleet mcp register-claude`: it fills the
 * secrets in itself, so no value is on a command line, and replaces only this
 * entry, so a failure leaves the old one.
 */
const claudeFix = (name: string, e: Endpoint) =>
  `t3-fleet mcp register-claude ${sh(name)} ${sh(JSON.stringify(e))}`;

/**
 * Codex's registration: `codex mcp add`, which replaces an entry whole (or
 * leaves it when it fails), then what it has no flag for (headers, variables
 * passed through) appended to the fresh entry in config.toml.
 */
const codexFix = (name: string, e: Endpoint) => {
  const table = `mcp_servers.${JSON.stringify(name)}`;
  const lines: Array<string> = [];
  let add: string;
  if (e.type === "http") {
    add = `--url ${sh(e.url)}${e.tokenEnv === null ? "" : ` --bearer-token-env-var ${e.tokenEnv}`}`;
    const literal: Array<string> = [];
    const passed: Array<string> = [];
    for (const [header, value] of Object.entries(e.headers ?? {})) {
      const ref = secretRef(value);
      (ref === null ? literal : passed).push(
        `${JSON.stringify(header)} = ${JSON.stringify(ref ?? value)}`,
      );
    }
    if (literal.length > 0) lines.push(`[${table}.http_headers]`, ...literal);
    if (passed.length > 0) lines.push(`[${table}.env_http_headers]`, ...passed);
  } else {
    const run = codexStdio(e);
    const words = [e.command, ...e.args].map((a) => dq(homeVar(a)));
    add = [
      ...Object.entries(run.env).map(([k, v]) => `--env ${sh(`${k}=${v}`)}`),
      "--",
      ...(run.args === e.args ? words : ["sh", "-c", sh(run.args[1] ?? "")]),
    ].join(" ");
    for (const v of run.vars) lines.push(`[[${table}.env_vars]]`, `name = ${JSON.stringify(v)}`);
  }
  const append =
    lines.length === 0
      ? ""
      : ` && printf '%s\\n' '' ${lines.map(sh).join(" ")} >> "\${CODEX_HOME:-$HOME/.codex}/config.toml"`;
  return `codex mcp add ${sh(name)} ${add}${append}`;
};

export const McpArea = defineArea({
  id: "mcp",
  description: "MCP servers registered in every agent client, and answering",
  desired: Desired,
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const has = (bin: string) =>
        exec({
          command: "sh",
          args: ["-c", `command -v ${bin}`],
          env: ctx.env,
          timeout: Duration.seconds(5),
        }).pipe(Effect.map((r) => r.code === 0));
      const clients = { claude: yield* has("claude"), codex: yield* has("codex") };

      // Every entry with every field, for what differs and what re-registering would drop.
      const claudeConfig = yield* claudeConfigPath(ctx.home, ctx.env).pipe(
        Effect.flatMap(readClaudeConfig),
        Effect.orElseSucceed((): ClaudeConfig => ({})),
      );
      const claudeRaw =
        Option.getOrUndefined(Schema.decodeOption(ClaudeJsonRaw)(claudeConfig))?.mcpServers ?? {};
      const codexText = yield* fs
        .readFileString(path.join(ctx.home, ".codex/config.toml"))
        .pipe(Effect.option);
      const codexAll = Option.isSome(codexText)
        ? ((
            (yield* Effect.try(() => parseToml(codexText.value)).pipe(
              Effect.orElseSucceed(() => ({})),
            )) as { mcp_servers?: Record<string, Record<string, unknown>> }
          ).mcp_servers ?? {})
        : {};

      // Secrets for registrations and live checks: the node's t3-fleet secrets file, then the environment.
      const secretsText = yield* fs
        .readFileString(path.join(configDir(ctx.home), "secrets.env"))
        .pipe(Effect.orElseSucceed(() => ""));
      const secrets = parseSecrets(secretsText);
      const secret = (name: string) => secrets[name] ?? ctx.env[name];
      /** Declared values with secrets filled in; a secret this node lacks is left out. */
      const filled = (values: Readonly<Record<string, string>> | undefined) => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(values ?? {})) {
          const ref = secretRef(value);
          const v = ref === null ? value : secret(ref);
          if (v !== undefined) out[key] = v;
        }
        return out;
      };
      const differs = (list: ReadonlyArray<string>) => (list.length === 0 ? {} : { differs: list });
      const text = (e: Readonly<Record<string, unknown>>, key: string) =>
        typeof e[key] === "string" ? e[key] : undefined;
      const table = (e: Readonly<Record<string, unknown>>, key: string) => {
        const value = e[key];
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Readonly<Record<string, unknown>>)
          : {};
      };
      const kind = (e: Readonly<Record<string, unknown>>) =>
        text(e, "url") !== undefined
          ? "http"
          : text(e, "command") !== undefined
            ? "stdio"
            : "other";

      // Claude stores values, the bearer token in an Authorization header; compared with the entry it should have.
      const fromClaude = (name: string, endpoint: Endpoint | null): Registered | null => {
        const e = claudeRaw[name];
        if (e === undefined) return null;
        const want = endpoint === null ? null : claudeEntry(endpoint, secret).entry;
        const kept = keptSettings(e, CLAUDE_WRITES, {
          env: Object.keys(want?.env ?? {}),
          headers: Object.keys(want?.headers ?? {}),
        });
        const keeps = kept.length === 0 ? {} : { kept };
        const unlike: Array<string> = [];
        if (want !== null) {
          if ((text(e, "type") ?? kind(e)) !== want.type) unlike.push("type");
          if (want.url !== undefined && text(e, "url") !== want.url) unlike.push("url");
          if (want.command !== undefined && text(e, "command") !== want.command)
            unlike.push("command");
          if (
            want.args !== undefined &&
            JSON.stringify(e["args"] ?? []) !== JSON.stringify(want.args)
          )
            unlike.push("args");
          for (const [k, v] of Object.entries(want.env ?? {}))
            if (table(e, "env")[k] !== v) unlike.push(`env ${k}`);
          for (const [k, v] of Object.entries(want.headers ?? {}))
            if (table(e, "headers")[k] !== v) unlike.push(`header ${k}`);
        }
        const type = kind(e);
        return type === "other" ? { type, ...keeps } : { type, ...differs(unlike), ...keeps };
      };
      // Codex keeps the variables' names, never a secret: compared with what its fix writes.
      const fromCodex = (name: string, endpoint: Endpoint | null): Registered | null => {
        const e = codexAll[name];
        if (e === undefined) return null;
        const unlike: Array<string> = [];
        let declared = {};
        let writes = CODEX_WRITES;
        if (endpoint?.type === "http") {
          if (e["url"] !== endpoint.url) unlike.push("url");
          if (e["bearer_token_env_var"] !== (endpoint.tokenEnv ?? undefined))
            unlike.push("bearer_token_env_var");
          if (endpoint.tokenEnv !== null) writes = [...CODEX_WRITES, "bearer_token_env_var"];
          const names = Object.keys(endpoint.headers ?? {});
          declared = { http_headers: names, env_http_headers: names };
          for (const [header, value] of Object.entries(endpoint.headers ?? {})) {
            const ref = secretRef(value);
            const [want, other] =
              ref === null
                ? ["http_headers", "env_http_headers"]
                : ["env_http_headers", "http_headers"];
            if (table(e, want)[header] !== (ref ?? value) || header in table(e, other))
              unlike.push(`header ${header}`);
          }
        } else if (endpoint?.type === "stdio") {
          const want = codexStdio(endpoint);
          // Every declared variable is set by the replacement, a secret by passing it through.
          declared = { env: Object.keys(endpoint.env ?? {}), env_vars: want.vars };
          if (e["command"] !== want.command) unlike.push("command");
          if (JSON.stringify(e["args"] ?? []) !== JSON.stringify(want.args)) unlike.push("args");
          const vars = Array.isArray(e["env_vars"])
            ? (e["env_vars"] as Array<unknown>).map((v) =>
                typeof v === "string" ? v : (v as { name?: unknown } | null)?.name,
              )
            : [];
          for (const key of new Set([...Object.keys(endpoint.env ?? {}), ...Object.keys(want.env)]))
            // A secret is passed through, never kept in config.toml.
            if (table(e, "env")[key] !== want.env[key]) unlike.push(`env ${key}`);
          for (const v of want.vars) if (!vars.includes(v)) unlike.push(`env_vars ${v}`);
        }
        const kept = keptSettings(e, writes, declared);
        const keeps = kept.length === 0 ? {} : { kept };
        const type = kind(e);
        return type === "other" ? { type, ...keeps } : { type, ...differs(unlike), ...keeps };
      };

      const servers = yield* Effect.forEach(
        desired?.servers ?? [],
        (name) =>
          Effect.gen(function* () {
            const text = yield* fs
              .readFileString(path.join(ctx.checkout, "mcp", `${name}.json`))
              .pipe(Effect.option);
            const def = Option.isSome(text)
              ? Schema.decodeOption(Schema.fromJsonString(Definition))(text.value)
              : Option.none();
            const resolved = Option.isNone(def)
              ? { endpoint: null, problem: `mcp/${name}.json is missing or not valid` }
              : resolveEndpoint(name, def.value, desired, ctx.home);
            const { endpoint, problem } = resolved;
            const tokenEnv = endpoint?.type === "http" ? endpoint.tokenEnv : null;
            const token = tokenEnv === null ? undefined : secret(tokenEnv);
            const live =
              endpoint?.type === "http"
                ? yield* liveCheck(expandEmbedded(endpoint.url, secret), token, {
                    headers: filled(endpoint.headers),
                    sse: endpoint.transport === "sse",
                  })
                : null;
            const missing = endpoint === null ? [] : claudeEntry(endpoint, secret).missing;
            return {
              name,
              endpoint,
              problem,
              claude: fromClaude(name, endpoint),
              codex: fromCodex(name, endpoint),
              live,
              ...(missing.length === 0 ? {} : { missing }),
            };
          }),
        { concurrency: 8 },
      );
      // Servers the clients have that the fleet does not declare here; T3 Fleet's own tools aside.
      const listed = [...(desired?.servers ?? []), ...(desired?.ignore ?? [])];
      const theirs = (entries: Readonly<Record<string, Readonly<Record<string, unknown>>>>) =>
        Object.entries(entries)
          .filter(([name, e]) => {
            const command = typeof e["command"] === "string" ? e["command"] : "";
            return (
              !listed.includes(name) && command.slice(command.lastIndexOf("/") + 1) !== "t3-fleet"
            );
          })
          .map(([name]) => name)
          .sort();
      const undeclared = {
        claude: clients.claude ? theirs(claudeRaw) : [],
        codex: clients.codex ? theirs(codexAll) : [],
      };
      // Claude's config and the backups Claude copies it to, readable by others: is a secret in one?
      // The secrets are what registration would fill in (the node's secrets, then its environment)
      // and every value in secrets.env; a false hit only suggests a harmless chmod 600. Only a
      // regular file others can read is read, within bounds, and only to look for those values.
      const declared = servers.flatMap((s) =>
        s.endpoint === null ? [] : claudeEntry(s.endpoint, secret).used,
      );
      const values = [
        ...new Set([
          ...Object.values(secrets),
          ...declared.filter((n) => !PLAIN_ENV.has(n)).flatMap((n) => secret(n) ?? []),
        ]),
      ]
        .filter((v) => v.length >= 4)
        .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
      const exposed: Array<string> = [];
      let unchecked = false;
      if (values.length > 0) {
        const backups = yield* claudeConfigBackups(ctx.home, ctx.env);
        unchecked = backups.incomplete;
        const config = yield* claudeConfigPath(ctx.home, ctx.env);
        const files = [
          {
            path: config,
            mode: yield* fs.stat(config).pipe(
              Effect.map((info) => info.mode & 0o777),
              Effect.orElseSucceed(() => 0o600),
            ),
          },
          ...backups.files,
        ];
        const scan = Effect.forEach(
          files.filter((f) => (f.mode & 0o077) !== 0),
          (f) =>
            holdsAny(f.path, values).pipe(
              Effect.map((holds) => {
                if (holds === null) unchecked = true;
                else if (holds)
                  exposed.push(
                    f.path.startsWith(`${ctx.home}/`)
                      ? `~/${f.path.slice(ctx.home.length + 1)}`
                      : f.path,
                  );
              }),
            ),
          { discard: true },
        );
        if (Option.isNone(yield* scan.pipe(Effect.timeout(Duration.seconds(10)), Effect.option)))
          unchecked = true;
      }
      // Relay node with the hub: what the hub itself says about each server.
      let hub:
        | ReadonlyArray<{ name: string; state: string; detail: string | null }>
        | null
        | undefined;
      if (desired?.hub === true && ctx.roles.includes("relay")) {
        const token = secrets[RELAY_TOKEN_ENV] ?? ctx.env[RELAY_TOKEN_ENV] ?? "";
        hub = yield* hubStates(ctx.relay?.port ?? 8399, token);
      }

      // Hub on: ToolHive workloads still serving what the hub serves.
      let toolhive: Array<string> | undefined;
      if (desired?.hub === true && (yield* has("thv"))) {
        const listed = yield* exec({
          command: "thv",
          args: ["list", "--format", "json"],
          env: ctx.env,
          timeout: Duration.seconds(15),
        });
        const workloads = listed.code === 0 ? toolhiveWorkloads(listed.stdout) : [];
        toolhive = [];
        for (const w of workloads) {
          const text = yield* fs
            .readFileString(path.join(ctx.checkout, "mcp", `${w}.json`))
            .pipe(Effect.option);
          const kind = Option.isSome(text)
            ? Option.getOrUndefined(
                Schema.decodeOption(Schema.fromJsonString(Definition))(text.value),
              )?.kind
            : undefined;
          if (kind !== undefined && isHosted(kind)) toolhive.push(w);
        }
      }
      return {
        servers,
        clients,
        ...(undeclared.claude.length + undeclared.codex.length === 0 ? {} : { undeclared }),
        ...(exposed.length === 0 ? {} : { exposed }),
        ...(unchecked ? { unchecked: true } : {}),
        ...(hub === undefined ? {} : { hub }),
        ...(toolhive === undefined ? {} : { toolhive }),
      };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    const needsLogin = new Map<string, string | null>();
    for (const h of observed.hub ?? [])
      if (h.state === NEEDS_LOGIN) needsLogin.set(h.name, h.detail);
    for (const s of observed.servers)
      if (s.live === NEEDS_LOGIN && !needsLogin.has(s.name)) needsLogin.set(s.name, null);
    for (const [name, detail] of needsLogin) {
      out.push({
        node,
        area: "mcp",
        key: `mcp-${name}-needs-login`,
        severity: "error",
        title: `MCP server ${name} needs a sign-in on the hub`,
        detail: `${detail === null ? "" : `${detail}; `}sign in from any machine: t3-fleet mcp login ${name}`,
      });
    }
    if (observed.toolhive !== undefined && observed.toolhive.length > 0) {
      const names = [...observed.toolhive].sort();
      out.push({
        node,
        area: "mcp",
        key: "mcp-toolhive-left",
        severity: "warn",
        title: `ToolHive still runs ${names.join(", ")}, which the T3 Fleet hub serves now`,
        detail:
          "stopping them leaves them in ToolHive (thv start brings one back); remove them with thv rm once the hub serves them",
        fix: {
          command: `thv stop ${names.map(sh).join(" ")}`,
          safe: false,
          disrupts: `${names.join(", ")} through ToolHive on ${node}, until the hub serves them (sign in with t3-fleet mcp login where needed)`,
        },
      });
    }
    const skipped =
      "more than 50 of them, larger than 4 MB, not a regular file, or too slow to read";
    const unchecked =
      observed.unchecked === true
        ? `; some copies were not looked into (${skipped}), so there may be more`
        : "";
    if (observed.exposed !== undefined && observed.exposed.length > 0) {
      const files = observed.exposed;
      out.push({
        node,
        area: "mcp",
        key: "mcp-claude-config-exposed",
        severity: "error",
        title: `${files.length === 1 ? "A copy of Claude's config holds" : `${files.length} copies of Claude's config hold`} secrets other users on ${node} can read`,
        detail: `${files.join(", ")}; making ${files.length === 1 ? "it" : "them"} readable by its owner alone (600) changes nothing else${unchecked}`,
        fix: { command: `chmod 600 ${files.map(shPath).join(" ")}`, safe: true },
      });
    } else if (observed.unchecked === true)
      out.push({
        node,
        area: "mcp",
        key: "mcp-claude-config-unchecked",
        severity: "info",
        title: `Some copies of Claude's config on ${node} were not checked for readable secrets`,
        detail: `copies others can read were not looked into (${skipped}); make any that may hold credentials readable by their owner alone (chmod 600)`,
      });
    if (observed.undeclared !== undefined) {
      const { claude, codex } = observed.undeclared;
      const names = [...new Set([...claude, ...codex])].sort();
      const where = (n: string) =>
        [claude.includes(n) ? "Claude" : "", codex.includes(n) ? "Codex" : ""]
          .filter(Boolean)
          .join(" and ");
      out.push({
        node,
        area: "mcp",
        key: "mcp-undeclared",
        severity: "info",
        title: `${node} has MCP servers the fleet does not declare for it: ${names.join(", ")}`,
        detail: `${names.map((n) => `${n} (${where(n)})`).join(", ")}; T3 Fleet leaves them alone. Bring one into the fleet with t3-fleet mcp add <name>, or all of them with t3-fleet setup; one the fleet already defines only needs listing in this machine's [mcp] servers. One that belongs to this machine alone goes in its [mcp] "ignore.add" = ["<name>"], and is not reported again`,
      });
    }
    for (const s of observed.servers) {
      const base = { node, area: "mcp" as const };
      if (s.endpoint === null) {
        out.push({
          ...base,
          key: `mcp-${s.name}-undefined`,
          severity: "error",
          title: `MCP server ${s.name}: ${s.problem ?? "cannot be resolved"}`,
        });
        continue;
      }
      const e = s.endpoint;
      const missing = s.missing ?? [];
      if (missing.length > 0)
        out.push({
          ...base,
          key: `mcp-${s.name}-secret-missing`,
          severity: "error",
          title: `MCP server ${s.name} needs ${missing.length === 1 ? "a secret" : "secrets"} this machine does not have: ${missing.join(", ")}`,
          detail: `set ${missing.length === 1 ? "it" : "them"} on an authority (t3-fleet secrets set ${missing.map((m) => `${m}=…`).join(" ")}); every machine gets the secrets on its next sync`,
        });
      // What Codex cannot take: the SSE transport, and a url with a secret in it, which only a literal could carry.
      const inUrl = e.type === "http" ? [...new Set(embeddedRefs(e.url))] : [];
      const notForCodex =
        e.type === "http" && e.transport === "sse"
          ? {
              why: "it speaks only the SSE transport",
              detail: "Codex connects to streamable HTTP and stdio servers only",
            }
          : inUrl.length > 0
            ? {
                why: `its URL holds ${inUrl.join(", ")}`,
                detail:
                  "Codex cannot fill a variable into a URL, and T3 Fleet does not write a secret into config.toml; if the server also takes the credential as a header, declare it in `headers` instead",
              }
            : null;
      if (notForCodex !== null && observed.clients.codex)
        out.push({
          ...base,
          key: `mcp-${s.name}-not-in-codex`,
          severity: "info",
          title: `Codex cannot use MCP server ${s.name}: ${notForCodex.why}`,
          detail: `${notForCodex.detail}, so T3 Fleet registers it in Claude alone`,
        });
      // Claude stores secrets' values: without them it would get empty ones.
      const redo = {
        claude:
          observed.clients.claude && missing.length === 0 && !sameEndpoint(e, s.claude, "claude"),
        codex: observed.clients.codex && notForCodex === null && !sameEndpoint(e, s.codex, "codex"),
      };
      if (redo.claude || redo.codex) {
        const fixes = [
          ...(redo.claude ? [claudeFix(s.name, e)] : []),
          ...(redo.codex ? [codexFix(s.name, e)] : []),
        ];
        const which = [redo.claude ? "Claude" : "", redo.codex ? "Codex" : ""]
          .filter(Boolean)
          .join(" and ");
        // Re-registering replaces the entry, so what only the old one had would be lost: a person decides.
        const dropped = [
          ...(redo.claude ? (s.claude?.kept ?? []).map((k) => `Claude's ${k}`) : []),
          ...(redo.codex ? (s.codex?.kept ?? []).map((k) => `Codex's ${k}`) : []),
        ];
        const target = e.type === "http" ? e.url : `${e.command} ${e.args.join(" ")}`.trim();
        out.push({
          ...base,
          key: `mcp-${s.name}-unregistered`,
          severity: "warn",
          title: `MCP server ${s.name} is not registered as declared in ${which}`,
          detail:
            dropped.length === 0
              ? target
              : `${target}; re-registering drops ${dropped.join(", ")}, which the definition does not have`,
          fix: { command: fixes.join("\n"), safe: dropped.length === 0 },
        });
      }
      if (s.live !== null && s.live !== "ok" && s.live !== NEEDS_LOGIN) {
        const tokenGone = /token temporarily unavailable|unauthori[sz]ed|401|403/i.test(s.live);
        out.push({
          ...base,
          key: `mcp-${s.name}-down`,
          severity: "error",
          title: `MCP server ${s.name} does not answer: ${s.live}`,
          ...(tokenGone
            ? {
                detail: `its credential has expired or was revoked; with the T3 Fleet hub, sign in with \`t3-fleet mcp login ${s.name}\`, otherwise sign in again in the MCP runner on the host`,
              }
            : {}),
        });
      }
    }
    return out;
  },
});
