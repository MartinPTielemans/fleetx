/**
 * t3-fleet mcp …: the MCP hub on the relay, from any node.
 *
 *   servers                       every hosted server and its state
 *   login NAME                    sign in: prints and opens the URL, waits for the login
 *   logout NAME                   drop the server's login
 *   restart NAME                  restart its container or process
 *   calls [--server] [--limit]    the tool-call log (never arguments or results)
 *   token create CLIENT [--server …]   a gateway token for one client, shown once
 *   token list | revoke CLIENT
 *
 * Every command goes through the relay (`[relay] url`, the relay token); the
 * hub itself holds the logins, so nothing here touches the local machine.
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import type { HubServer } from "@t3-fleet/core/Api";
import { loadConfig, type Config } from "@t3-fleet/core/Config";
import { exec } from "@t3-fleet/core/Exec";
import { commitAndPush } from "@t3-fleet/core/Git";
import { clientTokenEnv, expectOk, hubRequest } from "@t3-fleet/core/hub/HubClient";
import { toJson } from "@t3-fleet/core/hub/JsonRpc";
import { decodeCalls, decodeCreated, decodeLogin, decodeServers, decodeTokens } from "@t3-fleet/core/hub/Routes";
import { encryptedPath, installSecrets, readSecrets, setVar, writeSecrets } from "@t3-fleet/core/Secrets";

import { reportUserErrors } from "./shared.ts";

const nameArg = Argument.String("name").pipe(Argument.withDescription("The server's name, as in mcp/<name>.json."));

const servers = (config: Config) =>
  hubRequest(config, "GET", "/hub/servers").pipe(Effect.flatMap(expectOk), Effect.flatMap((t) => decodeServers(t).pipe(Effect.mapError(() => "the relay sent an unexpected answer"))));

const ago = (now: number, at: number | null) => {
  if (at === null) return "never";
  const s = Math.round((now - at) / 1000);
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

const until = (now: number, at: number | null) => {
  if (at === null) return "";
  const m = Math.round((at - now) / 60_000);
  return m <= 0 ? "expired" : m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
};

export const renderServers = (list: ReadonlyArray<HubServer>, now: number) => {
  if (list.length === 0) return "no hosted MCP servers (definitions with kind remote, container, registry or hosted-stdio in mcp/)";
  const width = Math.max(...list.map((s) => s.name.length));
  return list
    .map((s) => {
      const auth = s.auth === "oauth" ? `oauth${s.expiresAt === null ? "" : ` ${until(now, s.expiresAt)}`}` : s.auth;
      const tools = s.tools === null ? "" : `${s.tools} tools`;
      const line = `${s.name.padEnd(width)}  ${s.state.padEnd(11)}  ${s.kind.padEnd(12)}  ${auth.padEnd(10)}  ${tools.padEnd(9)}  checked ${ago(now, s.lastCheckAt)}`;
      const hint = s.state === "needs-login" ? `\n${" ".repeat(width)}  sign in: t3-fleet mcp login ${s.name}` : "";
      return `${line}${s.detail === null ? "" : `\n${" ".repeat(width)}  ${s.detail}`}${hint}`;
    })
    .join("\n");
};

const serversCommand = Command.make("servers").pipe(
  Command.withDescription("List the hub's hosted MCP servers and their state."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      yield* Console.log(renderServers(yield* servers(config), yield* Clock.currentTimeMillis));
    }).pipe(reportUserErrors),
  ),
);

/** Open a URL in the browser on this machine, when there is one; best effort. */
const openUrl = (url: string) =>
  exec({ command: process.platform === "darwin" ? "open" : "xdg-open", args: [url], timeout: Duration.seconds(5) }).pipe(Effect.map((r) => r.code === 0));

const loginCommand = Command.make("login", {
  name: nameArg,
  wait: Flag.Boolean("no-wait").pipe(Flag.withDescription("Print the URL and return without waiting for the sign-in."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Sign the hub in to a server: prints the URL to open in any browser on the tailnet."),
  Command.withHandler(({ name, wait: noWait }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const text = yield* hubRequest(config, "POST", `/hub/servers/${encodeURIComponent(name)}/login`).pipe(Effect.flatMap(expectOk));
      const { url } = yield* decodeLogin(text).pipe(Effect.mapError(() => "the relay sent an unexpected answer"));
      yield* Console.log(`Open this URL to sign in to ${name}:\n\n  ${url}\n`);
      if (process.stdout.isTTY === true) yield* openUrl(url);
      if (noWait) return;
      yield* Console.log("Waiting for the sign-in (Ctrl-C to stop waiting; the link stays valid for 10 minutes)…");
      for (let i = 0; i < 300; i++) {
        yield* Effect.sleep(Duration.seconds(2));
        const s = (yield* servers(config).pipe(Effect.orElseSucceed(() => []))).find((x) => x.name === name);
        if (s?.state === "running") {
          yield* Console.log(`Signed in: ${name} is running${s.tools === null ? "" : ` with ${s.tools} tools`}.`);
          return;
        }
        if (s?.state === "error" && s.detail !== null && !s.detail.startsWith("signed in")) {
          return yield* Effect.fail(`signed in, but ${name} is in error: ${s.detail}`);
        }
      }
      return yield* Effect.fail("no sign-in arrived within 10 minutes; run the command again");
    }).pipe(reportUserErrors),
  ),
);

const simple = (verb: "logout" | "restart", description: string, done: (name: string) => string) =>
  Command.make(verb, { name: nameArg }).pipe(
    Command.withDescription(description),
    Command.withHandler(({ name }) =>
      Effect.gen(function* () {
        const config = yield* loadConfig;
        yield* hubRequest(config, "POST", `/hub/servers/${encodeURIComponent(name)}/${verb}`).pipe(Effect.flatMap(expectOk));
        yield* Console.log(done(name));
      }).pipe(reportUserErrors),
    ),
  );

const callsCommand = Command.make("calls", {
  server: Flag.String("server").pipe(Flag.withDescription("Only calls to this server."), Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDescription("How many, newest first."), Flag.withDefault(50)),
}).pipe(
  Command.withDescription("Show the hub's recent tool calls: who called what, how long, how it ended. Never arguments or results."),
  Command.withHandler(({ server, limit }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const query = new URLSearchParams({ limit: String(limit), ...(server._tag === "Some" ? { server: server.value } : {}) });
      const text = yield* hubRequest(config, "GET", `/hub/calls?${query.toString()}`).pipe(Effect.flatMap(expectOk));
      const calls = yield* decodeCalls(text).pipe(Effect.mapError(() => "the relay sent an unexpected answer"));
      if (calls.length === 0) return yield* Console.log("no calls yet");
      for (const c of calls) {
        const when = DateTime.formatIso(DateTime.makeUnsafe(c.at)).replace("T", " ").slice(0, 19);
        const what = c.tool === null ? c.method : `${c.method} ${c.tool}`;
        yield* Console.log(`${when}  ${c.server}  ${c.client}  ${what}  ${c.durationMs}ms  ${c.outcome}${c.error === null ? "" : `: ${c.error}`}`);
      }
    }).pipe(reportUserErrors),
  ),
);

const clientArg = Argument.String("client").pipe(Argument.withDescription("A name for the client: a machine, an agent, a person."));

const tokenCreate = Command.make("create", {
  client: clientArg,
  server: Flag.String("server").pipe(Flag.withDescription("Only these servers (repeatable); default all."), Flag.atLeast(0)),
}).pipe(
  Command.withDescription("Create a gateway token for one client. Kept in the fleet's secrets on an authority; shown once otherwise."),
  Command.withHandler(({ client, server }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const body = toJson(server.length === 0 ? {} : { servers: server });
      const text = yield* hubRequest(config, "POST", `/hub/tokens/${encodeURIComponent(client)}`, body).pipe(Effect.flatMap(expectOk));
      const { token } = yield* decodeCreated(text).pipe(Effect.mapError(() => "the relay sent an unexpected answer"));
      const env = clientTokenEnv(config.repo, client);
      const self = config.nodes.find((n) => n.name === config.self);
      if (self?.roles.includes("authority")) {
        const secrets = setVar(yield* readSecrets(config.repo), env, token);
        yield* writeSecrets(config.repo, secrets);
        yield* installSecrets(config.repo);
        const rev = yield* commitAndPush(config.repo, [encryptedPath(config.repo).slice(config.repo.length + 1)], `Set secret ${env}`);
        yield* Console.log(`created a token for ${client}${server.length === 0 ? "" : ` (${server.join(", ")})`}, kept in the fleet's secrets as ${env} (${rev}).`);
        yield* Console.log(`Use it with [mcp] token_env = "${env}" on the nodes that should connect as ${client}.`);
      } else {
        yield* Console.log(`created a token for ${client}; it is shown only now:\n\n  ${token}\n`);
        yield* Console.log(`Keep it in the fleet's secrets from an authority: t3-fleet secrets set ${env}=…`);
      }
    }).pipe(reportUserErrors),
  ),
);

const tokenList = Command.make("list").pipe(
  Command.withDescription("List client tokens (names and scope; the tokens themselves are only stored hashed)."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const text = yield* hubRequest(config, "GET", "/hub/tokens").pipe(Effect.flatMap(expectOk));
      const tokens = yield* decodeTokens(text).pipe(Effect.mapError(() => "the relay sent an unexpected answer"));
      if (tokens.length === 0) return yield* Console.log("no client tokens; clients use the relay token");
      for (const t of tokens) {
        yield* Console.log(`${t.client}  ${t.servers === null ? "all servers" : t.servers.join(", ")}  created ${DateTime.formatIso(DateTime.makeUnsafe(t.createdAt)).slice(0, 10)}`);
      }
    }).pipe(reportUserErrors),
  ),
);

const tokenRevoke = Command.make("revoke", { client: clientArg }).pipe(
  Command.withDescription("Revoke a client's token; it stops working at once."),
  Command.withHandler(({ client }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      yield* hubRequest(config, "DELETE", `/hub/tokens/${encodeURIComponent(client)}`).pipe(Effect.flatMap(expectOk));
      yield* Console.log(`revoked ${client}'s token${config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") ? `; remove it from the secrets with t3-fleet secrets unset ${clientTokenEnv(config.repo, client)}` : ""}`);
    }).pipe(reportUserErrors),
  ),
);

const tokenCommand = Command.make("token").pipe(
  Command.withDescription("Per-client gateway tokens."),
  Command.withSubcommands([tokenCreate, tokenList, tokenRevoke]),
);

/** The hub's commands, registered under `t3-fleet mcp`. */
export const hubCommands = [
  serversCommand,
  loginCommand,
  simple("logout", "Drop the hub's login for a server.", (name) => `signed out of ${name}`),
  simple("restart", "Restart a hosted server's container or process.", (name) => `restarting ${name}`),
  callsCommand,
  tokenCommand,
] as const;
