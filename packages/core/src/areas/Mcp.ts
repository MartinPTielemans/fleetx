/**
 * MCP servers: declared once in the repo's mcp/<name>.json, registered in
 * every agent client on the nodes that list them, and checked live.
 *
 *   [mcp]
 *   servers = ["fetch", "executor"]     # which to register on this node
 *   hub = true                          # the relay's MCP hub serves hosted kinds
 *   gateway = "https://relay.tailnet.ts.net:8399"   # the relay, for hosted servers
 *   token_env = "FLEETX_MCP_TOKEN_LAPTOP"   # optional: a client token instead
 *                                       # of the relay token
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

import { defineArea, sh } from "../Area.ts";
import { expandHome } from "../Config.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { isHosted } from "../hub/Definitions.ts";

const Desired = Schema.UndefinedOr(
  Schema.Struct({
    servers: Schema.optionalKey(Schema.Array(Schema.String)),
    hub: Schema.optionalKey(Schema.Boolean),
    origin: Schema.optionalKey(Schema.String),
    ports: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
    gateway: Schema.optionalKey(Schema.String),
    token_env: Schema.optionalKey(Schema.String),
  }),
);
export type McpDesired = typeof Desired.Type;

const Definition = Schema.Struct({
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  auth: Schema.optionalKey(Schema.Struct({ type: Schema.String, token_env: Schema.optionalKey(Schema.String) })),
});

/** Where a client should reach a server. */
export const Endpoint = Schema.Union([
  Schema.Struct({ type: Schema.Literal("http"), url: Schema.String, tokenEnv: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("stdio"), command: Schema.String, args: Schema.Array(Schema.String) }),
]);
export type Endpoint = typeof Endpoint.Type;

/** What a client has registered under a name. */
const Registered = Schema.Union([
  Schema.Struct({ type: Schema.Literal("http"), url: Schema.String, auth: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("stdio"), command: Schema.String, args: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("other") }),
]);
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
    }),
  ),
  clients: Schema.Struct({ claude: Schema.Boolean, codex: Schema.Boolean }),
  /** Relay node with the hub on: each hosted server's state, as the hub reports it; null if unknown. */
  hub: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String, detail: Schema.NullOr(Schema.String) })))),
  /** Hub on: ToolHive workloads still running servers the hub serves. */
  toolhive: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeJson = Schema.Struct({
  mcpServers: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        url: Schema.optionalKey(Schema.String),
        command: Schema.optionalKey(Schema.String),
        args: Schema.optionalKey(Schema.Array(Schema.String)),
        headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  ),
});

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fleetx", version: "1" } },
});

/** The hub's gateway names a server's state in this header when it cannot serve it. */
const HUB_STATE_HEADER = "x-fleetx-hub-state";
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
): { readonly endpoint: Endpoint; readonly problem: null } | { readonly endpoint: null; readonly problem: string } => {
  const resolved = resolveUnchecked(name, d, desired, home);
  // The variable's name goes into fix commands unquoted; only a plain name may.
  if (resolved.endpoint?.type === "http" && resolved.endpoint.tokenEnv !== null && !ENV_NAME.test(resolved.endpoint.tokenEnv)) {
    return { endpoint: null, problem: `token_env ${JSON.stringify(resolved.endpoint.tokenEnv)} is not a variable name (A-Z, 0-9, _)` };
  }
  return resolved;
};

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const resolveUnchecked = (
  name: string,
  d: typeof Definition.Type,
  desired: McpDesired,
  home: string,
): { readonly endpoint: Endpoint; readonly problem: null } | { readonly endpoint: null; readonly problem: string } => {
  const tokenEnv = d.auth?.type === "bearer" ? (d.auth.token_env ?? null) : null;
  const fail = (problem: string) => ({ endpoint: null, problem }) as const;
  const ok = (endpoint: Endpoint) => ({ endpoint, problem: null }) as const;
  if (d.kind === "stdio") {
    if (d.command === undefined) return fail("stdio definition has no command");
    return ok({ type: "stdio", command: expandHome(d.command, home), args: (d.args ?? []).map((a) => expandHome(a, home)) });
  }
  if (d.kind === "direct") {
    if (d.url === undefined) return fail("direct definition has no url");
    return ok({ type: "http", url: d.url, tokenEnv });
  }
  const gateway = desired?.gateway?.replace(/\/+$/, "");
  const port = desired?.ports?.[name];
  if (desired?.hub === true) {
    if (!isHosted(d.kind)) return fail(`unknown kind ${d.kind}`);
    // The hub serves every hosted definition; clients authenticate to the gateway, never upstream.
    if (gateway === undefined) return fail("[mcp] hub = true, but no [mcp] gateway (the relay's URL)");
    return ok({ type: "http", url: `${gateway}/mcp/${name}`, tokenEnv: desired.token_env ?? "FLEETX_RELAY_TOKEN" });
  }
  if (gateway !== undefined && port !== undefined) {
    // Through the relay: one endpoint, one token, for every hosted server.
    return ok({ type: "http", url: `${gateway}/mcp/${name}`, tokenEnv: desired?.token_env ?? "FLEETX_RELAY_TOKEN" });
  }
  if (desired?.origin === undefined || port === undefined) return fail(`hosted server, but no [mcp] origin and port for ${name} (or [mcp] hub = true)`);
  return ok({ type: "http", url: `http://${desired.origin}:${port}/mcp`, tokenEnv });
};

/** An initialize request: what any client does first. No tool is called. */
const liveCheck = (url: string, token: string | undefined) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
      HttpClientRequest.bodyText(INITIALIZE, "application/json"),
    );
    if (token) request = HttpClientRequest.bearerToken(request, token);
    const result = yield* client.execute(request).pipe(
      Effect.flatMap((r) =>
        r.headers[HUB_STATE_HEADER] === "needs-login"
          ? Effect.succeed(NEEDS_LOGIN)
          : r.status >= 200 && r.status < 300
            ? Effect.succeed("ok")
            : r.text.pipe(Effect.map((t) => `HTTP ${r.status}: ${t.trim().slice(0, 80)}`)),
      ),
      Effect.timeout(Duration.seconds(8)),
      Effect.option,
    );
    return Option.getOrElse(result, () => "no answer within 8s");
  });

const HubStates = Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String, detail: Schema.NullOr(Schema.String) }));

/** The hub's view of its servers, from the relay on this node; null when it does not answer. */
const hubStates = (port: number, token: string) =>
  Effect.gen(function* () {
    if (token === "") return null;
    const client = yield* HttpClient.HttpClient;
    const text = yield* client.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/hub/servers`).pipe(HttpClientRequest.bearerToken(token))).pipe(
      Effect.flatMap((r) => (r.status === 200 ? r.text.pipe(Effect.asSome) : Effect.succeed(Option.none<string>()))),
      Effect.timeout(Duration.seconds(8)),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isNone(text)) return null;
    return Option.getOrNull(Schema.decodeOption(Schema.fromJsonString(HubStates))(text.value));
  });

/** Names of running workloads in `thv list --format json` output (an array, or null when there are none). */
export const toolhiveWorkloads = (text: string): Array<string> => {
  const value = Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text.trim() === "" ? "null" : text));
  if (!Array.isArray(value)) return [];
  return value
    .filter((w): w is { name: string; status?: unknown } => typeof w === "object" && w !== null && typeof (w as { name?: unknown }).name === "string")
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

const sameEndpoint = (want: Endpoint, got: Registered | null) =>
  got !== null &&
  (want.type === "http"
    ? got.type === "http" && got.url === want.url && got.auth === (want.tokenEnv !== null)
    : got.type === "stdio" && got.command === want.command && JSON.stringify(got.args) === JSON.stringify(want.args));

export const McpArea = defineArea({
  id: "mcp",
  description: "MCP servers registered in every agent client, and answering",
  desired: Desired,
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const has = (bin: string) => exec({ command: "sh", args: ["-c", `command -v ${bin}`], env: ctx.env, timeout: Duration.seconds(5) }).pipe(Effect.map((r) => r.code === 0));
      const clients = { claude: yield* has("claude"), codex: yield* has("codex") };

      const claudeText = yield* fs.readFileString(path.join(ctx.home, ".claude.json")).pipe(Effect.option);
      const claude = Option.isSome(claudeText)
        ? Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(ClaudeJson))(claudeText.value))?.mcpServers ?? {}
        : {};
      const codexText = yield* fs.readFileString(path.join(ctx.home, ".codex/config.toml")).pipe(Effect.option);
      const codexAll = Option.isSome(codexText)
        ? ((yield* Effect.try(() => parseToml(codexText.value)).pipe(Effect.orElseSucceed(() => ({})))) as { mcp_servers?: Record<string, Record<string, unknown>> }).mcp_servers ?? {}
        : {};

      const fromClaude = (name: string): Registered | null => {
        const e = claude[name];
        if (e === undefined) return null;
        if (e.url !== undefined) return { type: "http", url: e.url, auth: e.headers?.["Authorization"] !== undefined };
        if (e.command !== undefined) return { type: "stdio", command: e.command, args: e.args ?? [] };
        return { type: "other" };
      };
      const fromCodex = (name: string): Registered | null => {
        const e = codexAll[name];
        if (e === undefined) return null;
        if (typeof e["url"] === "string") return { type: "http", url: e["url"], auth: typeof e["bearer_token_env_var"] === "string" };
        if (typeof e["command"] === "string") return { type: "stdio", command: e["command"], args: (e["args"] as Array<string> | undefined) ?? [] };
        return { type: "other" };
      };

      // Secrets for live checks: the node's fleetx secrets file, then the environment.
      const secretsText = yield* fs.readFileString(path.join(ctx.home, ".config/fleetx/secrets.env")).pipe(Effect.orElseSucceed(() => ""));
      const secrets: Record<string, string> = {};
      for (const line of secretsText.split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
        if (m?.[1] !== undefined) secrets[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
      }

      const servers = yield* Effect.forEach(
        desired?.servers ?? [],
        (name) =>
          Effect.gen(function* () {
            const text = yield* fs.readFileString(path.join(ctx.checkout, "mcp", `${name}.json`)).pipe(Effect.option);
            const def = Option.isSome(text) ? Schema.decodeOption(Schema.fromJsonString(Definition))(text.value) : Option.none();
            const resolved = Option.isNone(def)
              ? { endpoint: null, problem: `mcp/${name}.json is missing or not valid` }
              : resolveEndpoint(name, def.value, desired, ctx.home);
            const { endpoint, problem } = resolved;
            const live =
              endpoint?.type === "http"
                ? yield* liveCheck(endpoint.url, endpoint.tokenEnv === null ? undefined : (secrets[endpoint.tokenEnv] ?? ctx.env[endpoint.tokenEnv]))
                : null;
            return { name, endpoint, problem, claude: fromClaude(name), codex: fromCodex(name), live };
          }),
        { concurrency: 8 },
      );
      // Relay node with the hub: what the hub itself says about each server.
      let hub: ReadonlyArray<{ name: string; state: string; detail: string | null }> | null | undefined;
      if (desired?.hub === true && ctx.roles.includes("relay")) {
        const token = secrets["FLEETX_RELAY_TOKEN"] ?? ctx.env["FLEETX_RELAY_TOKEN"] ?? "";
        hub = yield* hubStates(ctx.relay?.port ?? 8399, token);
      }

      // Hub on: ToolHive workloads still serving what the hub serves.
      let toolhive: Array<string> | undefined;
      if (desired?.hub === true && (yield* has("thv"))) {
        const listed = yield* exec({ command: "thv", args: ["list", "--format", "json"], env: ctx.env, timeout: Duration.seconds(15) });
        const workloads = listed.code === 0 ? toolhiveWorkloads(listed.stdout) : [];
        toolhive = [];
        for (const w of workloads) {
          const text = yield* fs.readFileString(path.join(ctx.checkout, "mcp", `${w}.json`)).pipe(Effect.option);
          const kind = Option.isSome(text) ? Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(Definition))(text.value))?.kind : undefined;
          if (kind !== undefined && isHosted(kind)) toolhive.push(w);
        }
      }
      return { servers, clients, ...(hub === undefined ? {} : { hub }), ...(toolhive === undefined ? {} : { toolhive }) };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    const needsLogin = new Map<string, string | null>();
    for (const h of observed.hub ?? []) if (h.state === NEEDS_LOGIN) needsLogin.set(h.name, h.detail);
    for (const s of observed.servers) if (s.live === NEEDS_LOGIN && !needsLogin.has(s.name)) needsLogin.set(s.name, null);
    for (const [name, detail] of needsLogin) {
      out.push({
        node,
        area: "mcp",
        key: `mcp-${name}-needs-login`,
        severity: "error",
        title: `MCP server ${name} needs a sign-in on the hub`,
        detail: `${detail === null ? "" : `${detail}; `}sign in from any machine: fleetx mcp login ${name}`,
      });
    }
    if (observed.toolhive !== undefined && observed.toolhive.length > 0) {
      const names = [...observed.toolhive].sort();
      out.push({
        node,
        area: "mcp",
        key: "mcp-toolhive-left",
        severity: "warn",
        title: `ToolHive still runs ${names.join(", ")}, which the fleetx hub serves now`,
        detail: "stopping them leaves them in ToolHive (thv start brings one back); remove them with thv rm once the hub serves them",
        fix: { command: `thv stop ${names.map(sh).join(" ")}`, safe: false, disrupts: `${names.join(", ")} through ToolHive on ${node}, until the hub serves them (sign in with fleetx mcp login where needed)` },
      });
    }
    const loadSecrets = "set -a; [ -f ~/.config/fleetx/secrets.env ] && . ~/.config/fleetx/secrets.env; set +a";
    for (const s of observed.servers) {
      const base = { node, area: "mcp" as const };
      if (s.endpoint === null) {
        out.push({ ...base, key: `mcp-${s.name}-undefined`, severity: "error", title: `MCP server ${s.name}: ${s.problem ?? "cannot be resolved"}` });
        continue;
      }
      const e = s.endpoint;
      const homeVar = (p: string) => p.replace(/^\/(Users|home)\/[^/]+\//, "$HOME/").replace(/^\/root\//, "$HOME/");
      const claudeJson =
        e.type === "http"
          ? JSON.stringify({ type: "http", url: e.url, ...(e.tokenEnv === null ? {} : { headers: { Authorization: `Bearer $${e.tokenEnv}` } }) })
          : JSON.stringify({ type: "stdio", command: homeVar(e.command), args: e.args.map(homeVar) });
      const fixes: Array<string> = [];
      if (observed.clients.claude && !sameEndpoint(e, s.claude)) {
        const secrets = e.type === "http" && e.tokenEnv !== null ? `${loadSecrets}; ` : "";
        fixes.push(`${secrets}claude mcp remove -s user ${sh(s.name)} >/dev/null 2>&1; claude mcp add-json -s user ${sh(s.name)} ${dq(claudeJson)}`);
      }
      if (observed.clients.codex && !sameEndpoint(e, s.codex)) {
        fixes.push(
          `codex mcp remove ${sh(s.name)} >/dev/null 2>&1; codex mcp add ${sh(s.name)} ${
            e.type === "http"
              ? `--url ${sh(e.url)}${e.tokenEnv === null ? "" : ` --bearer-token-env-var ${e.tokenEnv}`}`
              : `-- ${[e.command, ...e.args].map((a) => dq(homeVar(a))).join(" ")}`
          }`,
        );
      }
      if (fixes.length > 0) {
        const which = [observed.clients.claude && !sameEndpoint(e, s.claude) ? "Claude" : "", observed.clients.codex && !sameEndpoint(e, s.codex) ? "Codex" : ""].filter(Boolean).join(" and ");
        out.push({
          ...base,
          key: `mcp-${s.name}-unregistered`,
          severity: "warn",
          title: `MCP server ${s.name} is not registered as declared in ${which}`,
          detail: e.type === "http" ? e.url : `${e.command} ${e.args.join(" ")}`.trim(),
          fix: { command: fixes.join("\n"), safe: true },
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
                detail: `its credential has expired or was revoked; with the fleetx hub, sign in with \`fleetx mcp login ${s.name}\`, otherwise sign in again in the MCP runner on the host`,
              }
            : {}),
        });
      }
    }
    return out;
  },
});
