/**
 * MCP servers: declared once in the repo's mcp/<name>.json, registered in
 * every agent client on the nodes that list them, and checked live.
 *
 *   [mcp]
 *   servers = ["fetch", "executor"]     # which to register on this node
 *   origin = "server.tailnet.ts.net"    # host serving hosted servers
 *   ports = { fetch = 18100 }           # hosted server → port on the origin
 *   gateway = "https://relay.tailnet.ts.net:8399"   # optional: reach hosted
 *                                       # servers through the relay instead
 *
 * A definition's `kind` decides where clients connect:
 *
 *   stdio     run `command` with `args` on the node itself
 *   direct    connect to `url`
 *   remote, container, registry
 *             hosted on the origin (ToolHive there, say): clients connect to
 *             http://<origin>:<port>/mcp, with no proxy on the node
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

const Desired = Schema.UndefinedOr(
  Schema.Struct({
    servers: Schema.optionalKey(Schema.Array(Schema.String)),
    origin: Schema.optionalKey(Schema.String),
    ports: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
    gateway: Schema.optionalKey(Schema.String),
  }),
);

const Definition = Schema.Struct({
  kind: Schema.String,
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  auth: Schema.optionalKey(Schema.Struct({ type: Schema.String, token_env: Schema.optionalKey(Schema.String) })),
});

/** Where a client should reach a server. */
const Endpoint = Schema.Union([
  Schema.Struct({ type: Schema.Literal("http"), url: Schema.String, tokenEnv: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("stdio"), command: Schema.String, args: Schema.Array(Schema.String) }),
]);
type Endpoint = typeof Endpoint.Type;

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
      Effect.flatMap((r) => (r.status >= 200 && r.status < 300 ? Effect.succeed("ok") : r.text.pipe(Effect.map((t) => `HTTP ${r.status}: ${t.trim().slice(0, 80)}`)))),
      Effect.timeout(Duration.seconds(8)),
      Effect.option,
    );
    return Option.getOrElse(result, () => "no answer within 8s");
  });

/** Double-quote for the shell, leaving only $VAR expansions active. */
const dq = (text: string) => `"${text.replace(/[\\"`]/g, "\\$&")}"`;

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
            let endpoint: Endpoint | null = null;
            let problem: string | null = null;
            if (Option.isNone(def)) problem = `mcp/${name}.json is missing or not valid`;
            else {
              const d = def.value;
              const tokenEnv = d.auth?.type === "bearer" ? (d.auth.token_env ?? null) : null;
              if (d.kind === "stdio") {
                if (d.command === undefined) problem = "stdio definition has no command";
                else endpoint = { type: "stdio", command: expandHome(d.command, ctx.home), args: (d.args ?? []).map((a) => expandHome(a, ctx.home)) };
              } else if (d.kind === "direct") {
                if (d.url === undefined) problem = "direct definition has no url";
                else endpoint = { type: "http", url: d.url, tokenEnv };
              } else {
                const port = desired?.ports?.[name];
                if (desired?.gateway !== undefined && port !== undefined) {
                  // Through the relay: one endpoint, one token, for every hosted server.
                  endpoint = { type: "http", url: `${desired.gateway.replace(/\/+$/, "")}/mcp/${name}`, tokenEnv: "FLEETX_RELAY_TOKEN" };
                } else if (desired?.origin === undefined || port === undefined) problem = `hosted server, but no [mcp] origin and port for ${name}`;
                else endpoint = { type: "http", url: `http://${desired.origin}:${port}/mcp`, tokenEnv };
              }
            }
            const live =
              endpoint?.type === "http"
                ? yield* liveCheck(endpoint.url, endpoint.tokenEnv === null ? undefined : (secrets[endpoint.tokenEnv] ?? ctx.env[endpoint.tokenEnv]))
                : null;
            return { name, endpoint, problem, claude: fromClaude(name), codex: fromCodex(name), live };
          }),
        { concurrency: 8 },
      );
      return { servers, clients };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
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
      if (s.live !== null && s.live !== "ok") {
        const tokenGone = /token temporarily unavailable|unauthori[sz]ed|401|403/i.test(s.live);
        out.push({
          ...base,
          key: `mcp-${s.name}-down`,
          severity: "error",
          title: `MCP server ${s.name} does not answer: ${s.live}`,
          ...(tokenGone
            ? { detail: "its credential on the host has expired or was revoked; sign in again there (the host's MCP runner, for example `thv proxy` OAuth for ToolHive)" }
            : {}),
        });
      }
    }
    return out;
  },
});
