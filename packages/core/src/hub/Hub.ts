/**
 * The hub: every hosted MCP server in the repo, behind one gateway.
 *
 * It keeps one runtime entry per server (its runner, its upstream, its
 * state), and does four things with them:
 *
 *   gateway   authenticate the client (the relay token, or a client token
 *             compared by digest), apply the server's tool policy, forward to
 *             the upstream, and log every JSON-RPC request as a HubCall
 *   health    every minute: re-read the definitions (starting, replacing or
 *             stopping servers), refresh OAuth logins ahead of expiry, and
 *             run an initialize and tools/list against each server. One
 *             server's check cannot stop the others'; a process or container
 *             that misses three checks in a row is restarted
 *   lifecycle starting, stopping, restarting and reloading take turns, so a
 *             server never runs twice
 *   logins    start and finish OAuth sign-ins; sign out
 *   tokens    create, list and revoke per-client gateway tokens
 *
 * State changes are handed to `emit`, which the relay turns into `hub`
 * events on /events. A server whose login is gone goes to `needs-login`; the
 * mcp area turns that into a finding, which the relay node's sync alerts on.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { HubCall, HubServer, HubServerState } from "../Api.ts";
import { expandHome } from "../Config.ts";
import { makeBridge, type Bridge } from "./Bridge.ts";
import { makeCallLog, type CallLog } from "./Calls.ts";
import { loadDefinitions, portDefinition, resolvedEnv, type HubDefinition } from "./Definitions.ts";
import {
  containerName,
  ensureHttpContainer,
  inspect,
  removeContainer,
  spawnStdioContainer,
} from "./Docker.ts";
import {
  errorMessage,
  idKey,
  isEventStream,
  isRequest,
  isResponse,
  makeSseParser,
  messagesInBody,
  parseMessages,
  sseFrame,
  toJson,
  caseVariantKey,
  rebuildMessage,
  toolOf,
  type JsonRpcMessage,
} from "./JsonRpc.ts";
import {
  makeOAuthManager,
  type LoginStatus,
  type OAuthManager,
  type TokenTarget,
} from "./OAuth.ts";
import {
  bearerMatches,
  bearerOf,
  compileDeny,
  constantTimeEqual,
  hashToken,
  newClientToken,
} from "./Policy.ts";
import { spawnStdio } from "./Process.ts";
import { makeSessionOwners, type SessionOwners } from "./SessionOwners.ts";
import { makeTokenStore, tokenStorePath, type TokenStore } from "./TokenStore.ts";
import {
  makeProxy,
  readBody,
  textResponse,
  UpstreamError,
  type Credential,
  type ForwardRequest,
  type Upstream,
  type UpstreamResponse,
} from "./Upstream.ts";
import { configDir, header, stateDir as fleetStateDir } from "../Names.ts";

export interface HubEvent {
  readonly server: string;
  readonly state: HubServerState;
  readonly detail: string | null;
}

export interface HubConfig {
  /** The config repo on this node, where mcp/<name>.json live. */
  readonly repo: string;
  readonly home: string;
  /** False: serve only `ports` (the gateway without the hub). */
  readonly enabled: boolean;
  /** Servers already listening on a local port (`[mcp] ports`), served as they are. */
  readonly ports: Readonly<Record<string, number>>;
  /**
   * `enabled` and `ports` as they are now, read on every reload instead of
   * the values given at the start: the relay follows the config repo, so
   * turning the hub on there serves the hosted servers without a restart.
   */
  readonly serving?: Effect.Effect<{
    readonly enabled: boolean;
    readonly ports: Readonly<Record<string, number>>;
  }>;
  /** The relay's public URL; OAuth redirects to `<url>/oauth/callback`. */
  readonly relayUrl: string | null;
  /** This node's age identity, for the token store. */
  readonly identity: string;
  /** The shared relay token; accepted by the gateway as client "relay". */
  readonly relayToken: string;
  readonly version: string;
  /** Default ~/.local/state/t3-fleet/hub. */
  readonly stateDir?: string;
  readonly checkEvery?: Duration.Input;
  /** Tests only: accept plain-HTTP OAuth URLs on loopback. Never set in the relay. */
  readonly allowLoopbackHttp?: boolean;
  /** Secrets for credentials and environments; default the node's secrets.env. */
  readonly secrets?: Effect.Effect<Readonly<Record<string, string>>>;
}

export interface ClientTokenInfo {
  readonly client: string;
  readonly servers: ReadonlyArray<string> | null;
  readonly createdAt: number;
}

export interface Hub {
  readonly servers: Effect.Effect<ReadonlyArray<HubServer>>;
  readonly calls: CallLog["list"];
  /** Check a gateway request's token before anything else is read; rejections are logged once. */
  readonly authorize: (
    name: string,
    authorization: string | undefined,
    method: string,
  ) => Effect.Effect<{ readonly client: string } | { readonly rejected: UpstreamResponse }>;
  /** Serve an authorized request: policy, forwarding, logging. */
  readonly serve: (
    name: string,
    client: string,
    request: ForwardRequest,
  ) => Effect.Effect<UpstreamResponse>;
  /** `authorize`, then `serve`. */
  readonly gateway: (
    name: string,
    authorization: string | undefined,
    request: ForwardRequest,
  ) => Effect.Effect<UpstreamResponse>;
  readonly login: (name: string) => Effect.Effect<string, string>;
  readonly finishLogin: (
    query: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<string, string>;
  /** How the sign-in with this state (from the login URL) is going. */
  readonly loginStatus: (state: string) => Effect.Effect<LoginStatus>;
  readonly logout: (name: string) => Effect.Effect<void, string>;
  readonly restart: (name: string) => Effect.Effect<void, string>;
  readonly createToken: (
    client: string,
    servers: ReadonlyArray<string> | null,
  ) => Effect.Effect<string, string>;
  readonly listTokens: Effect.Effect<ReadonlyArray<ClientTokenInfo>>;
  readonly revokeToken: (client: string) => Effect.Effect<boolean>;
  /** Run the health check now (all servers, or one). */
  readonly check: (name?: string) => Effect.Effect<void>;
}

interface Entry {
  readonly def: HubDefinition;
  /** Changes when the definition or its resolved environment changes. */
  readonly key: string;
  readonly scope: Scope.Closeable;
  /** What clients reach. */
  readonly upstream: Upstream;
  /** The same server for the health check, outside the count of client requests. */
  readonly probe: Upstream;
  readonly bridge: Bridge | null;
  /** Client requests the server has not finished answering. */
  readonly clientRequests: Effect.Effect<number>;
  /** HTTP container: its local port once running. */
  port: number | null;
  state: HubServerState;
  detail: string | null;
  tools: number | null;
  lastCheckAt: number | null;
  /** The last WWW-Authenticate challenge, for OAuth discovery. */
  challenge: string | null;
  /** The server asked for a login though its definition did not say so. */
  oauthDetected: boolean;
  /** The definition's deny patterns, compiled once. */
  readonly denied: (tool: string) => boolean;
  /** Health checks in a row that got no answer. */
  missed: number;
}

/** Parse dotenv text: KEY=value lines, optional `export`, simple quotes. */
export const parseDotenv = (text: string) => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] === undefined) continue;
    const raw = (m[2] ?? "").trim();
    out[m[1]] =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\(.)/g, "$1")
        : raw.replace(/^'(.*)'$/, "$1");
  }
  return out;
};

const CLIENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Health checks in a row without an answer before a process or container is restarted. */
const MISSED_CHECKS = 3;

/** What a health check reads from initialize and tools/list. */
const decodeInitializeResult = Schema.decodeUnknownOption(
  Schema.Struct({ protocolVersion: Schema.String }),
);
const decodeToolList = Schema.decodeUnknownOption(
  Schema.Struct({ tools: Schema.Array(Schema.Unknown) }),
);
const isNamedTool = Schema.is(Schema.Struct({ name: Schema.String }));
const errorText = (error: unknown) =>
  Option.match(Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(error), {
    onNone: () => "an error",
    onSome: (e) => e.message.slice(0, 200),
  });

/** An upstream that counts the POSTs it is still answering: a busy server is not a hung one. */
const counted = (inner: Upstream) => {
  let inFlight = 0;
  const upstream: Upstream = {
    forward: (request) =>
      request.method !== "POST"
        ? inner.forward(request)
        : Effect.gen(function* () {
            let done = false;
            const finish = Effect.sync(() => {
              if (!done) inFlight--;
              done = true;
            });
            inFlight++;
            const response = yield* inner
              .forward(request)
              .pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? finish : Effect.void)));
            return { ...response, body: response.body.pipe(Stream.ensuring(finish)) };
          }),
  };
  return { upstream, inFlight: Effect.sync(() => inFlight) };
};

const stateHeaders = (state: string) => ({ [header("hub-state")]: state });

const jsonRpcFailure = (
  status: number,
  message: string,
  headers: Readonly<Record<string, string>> = {},
) => textResponse(status, toJson(errorMessage(null, -32001, message)), headers);

/**
 * What the log keeps of a JSON-RPC error: its code and words the hub writes.
 * Never the server's message, which often echoes the arguments.
 */
const errorReason = (m: JsonRpcMessage): string | null => {
  if (m.error === undefined) return null;
  const code = (m.error as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code)
    ? `JSON-RPC error ${code}`
    : "JSON-RPC error";
};

/** The parts of a request the call log needs. */
interface Requested {
  readonly id: string;
  readonly method: string;
  readonly tool: string | null;
}

export const makeHub = (
  config: HubConfig,
  emit: (event: HubEvent) => Effect.Effect<void>,
): Effect.Effect<
  Hub,
  never,
  | Scope.Scope
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | HttpClient.HttpClient
    >();
    const hubScope = yield* Effect.scope;
    const stateDir = config.stateDir ?? path.join(fleetStateDir(config.home), "hub");
    const secrets =
      config.secrets ??
      fs.readFileString(path.join(configDir(config.home), "secrets.env")).pipe(
        Effect.map(parseDotenv),
        Effect.orElseSucceed(() => ({}) as Record<string, string>),
      );
    const store: TokenStore = yield* makeTokenStore({
      file:
        config.stateDir === undefined
          ? tokenStorePath(config.home)
          : path.join(stateDir, "tokens.age"),
      identity: config.identity,
    });
    const log = yield* makeCallLog(path.join(stateDir, "calls.jsonl"));
    const owners: SessionOwners = yield* makeSessionOwners(path.join(stateDir, "sessions.json"));
    const redirectUri =
      config.relayUrl === null ? "" : `${config.relayUrl.replace(/\/+$/, "")}/oauth/callback`;
    const oauth: OAuthManager = yield* makeOAuthManager({
      store,
      redirectUri,
      secrets,
      clientName: "T3 Fleet hub",
      allowLoopbackHttp: config.allowLoopbackHttp === true,
    });

    const entries = new Map<string, Entry>();
    let problems: ReadonlyArray<{ readonly name: string; readonly problem: string }> = [];
    /** Starting, stopping, restarting and reloading take turns. */
    const lifecycle = yield* Semaphore.make(1);
    const checkEvery = Duration.fromInputUnsafe(config.checkEvery ?? Duration.minutes(1));
    /** A check gets half the period between checks, and never more than 30 seconds. */
    const checkTimeout = Duration.min(Duration.seconds(30), Duration.divideUnsafe(checkEvery, 2));

    const setState = (entry: Entry, state: HubServerState, detail: string | null) =>
      Effect.gen(function* () {
        if (entries.get(entry.def.name) !== entry) return;
        const changed = entry.state !== state || entry.detail !== detail;
        entry.state = state;
        entry.detail = detail;
        if (!changed) return;
        if (state === "needs-login")
          yield* Effect.logWarning(
            `hub: ${entry.def.name} needs a sign-in: t3-fleet mcp login ${entry.def.name}`,
          );
        if (state === "error")
          yield* Effect.logWarning(`hub: ${entry.def.name}: ${detail ?? "error"}`);
        yield* emit({ server: entry.def.name, state, detail });
      });

    const usesOAuth = (entry: Entry) => entry.def.auth.type === "oauth" || entry.oauthDetected;

    /** `target`: the URL the token goes to, or null for a container on this machine (see TokenTarget). */
    const credentialFor = (entry: () => Entry, target: TokenTarget): Credential => ({
      token: Effect.gen(function* () {
        const e = entry();
        const auth = e.def.auth;
        if (auth.type === "bearer") {
          const value = (yield* secrets)[auth.tokenEnv];
          if (value === undefined || value === "")
            return yield* new UpstreamError({
              message: `the secret ${auth.tokenEnv} is not set on the relay node`,
            });
          return value;
        }
        if (usesOAuth(e) || (yield* oauth.hasTokens(e.def.name, target)))
          return yield* oauth.accessToken(e.def.name, target);
        return null;
      }),
      rejected: (token, challenge) =>
        Effect.gen(function* () {
          const e = entry();
          e.challenge = challenge;
          if (e.def.auth.type === "bearer")
            return yield* new UpstreamError({
              message: `the server rejected the secret ${e.def.auth.tokenEnv}`,
            });
          if (token === null) {
            e.oauthDetected = true;
            return yield* oauth.accessToken(e.def.name, target);
          }
          return yield* oauth.afterRejection(e.def.name, target, token);
        }),
    });

    // ── runners ─────────────────────────────────────────────────────────

    const start = (def: HubDefinition, key: string) =>
      Effect.gen(function* () {
        // Never two entries for one server: whatever runs under this name stops first.
        const previous = entries.get(def.name);
        if (previous !== undefined) yield* stop(previous, false);
        const scope = yield* Scope.fork(hubScope);
        const env = resolvedEnv("env" in def.runner ? def.runner.env : {}, yield* secrets);
        let entry: Entry;
        const self = () => entry;
        const provide = <A, E>(
          effect: Effect.Effect<
            A,
            E,
            | Scope.Scope
            | FileSystem.FileSystem
            | ChildProcessSpawner.ChildProcessSpawner
            | HttpClient.HttpClient
          >,
        ) => effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(services));
        const r = def.runner;
        let upstream: Upstream;
        let bridge: Bridge | null = null;
        let clientRequests: Effect.Effect<number> = Effect.succeed(0);
        if (r.type === "remote" || r.type === "port") {
          const url = r.type === "remote" ? r.url : `http://127.0.0.1:${r.port}/mcp`;
          upstream = yield* provide(makeProxy(def.name, url, credentialFor(self, url)));
        } else if (r.type === "docker-http") {
          const proxies = new Map<number, Upstream>();
          upstream = {
            forward: (request) =>
              Effect.gen(function* () {
                const port = self().port;
                if (port === null)
                  return yield* new UpstreamError({ message: `${def.name} is not running yet` });
                let proxy = proxies.get(port);
                if (proxy === undefined) {
                  // The container's port changes with every start; its login goes with the definition.
                  proxy = yield* provide(
                    makeProxy(
                      def.name,
                      `http://127.0.0.1:${port}${r.path}`,
                      credentialFor(self, null),
                    ),
                  );
                  proxies.set(port, proxy);
                }
                return yield* proxy.forward(request);
              }),
          };
        } else {
          const spawn =
            r.type === "docker-stdio"
              ? spawnStdioContainer({
                  server: def.name,
                  image: r.image,
                  args: r.args,
                  env,
                  network: r.network,
                })
              : spawnStdio({
                  command: expandHome(r.command, config.home),
                  args: r.args.map((a) => expandHome(a, config.home)),
                  env,
                });
          bridge = yield* provide(
            makeBridge({
              name: def.name,
              spawn: provide(spawn),
              version: config.version,
              // Report the process's state as it changes, not only at the next check.
              onStatus: () =>
                Effect.suspend(() => (entry === undefined ? Effect.void : check(entry))).pipe(
                  Effect.forkIn(scope),
                  Effect.asVoid,
                ),
              onSessionEnd: (session) => owners.end(def.name, session),
            }),
          );
          upstream = bridge;
          clientRequests = bridge.clientRequests;
        }
        const probe = upstream;
        if (r.type === "docker-http") {
          const tracked = counted(upstream);
          upstream = tracked.upstream;
          clientRequests = tracked.inFlight;
        }
        entry = {
          def,
          key,
          scope,
          upstream,
          probe,
          bridge,
          clientRequests,
          port: null,
          state: "starting",
          detail: null,
          tools: null,
          lastCheckAt: null,
          challenge: null,
          oauthDetected: false,
          denied: compileDeny(def.deny),
          missed: 0,
        };
        entries.set(def.name, entry);
        yield* emit({ server: def.name, state: "starting", detail: null });

        if (r.type === "docker-http") {
          // Keep the container running: adopt or start it, watch it, restart with backoff.
          const reserved = () =>
            new Set(
              [...entries.values()]
                .filter((e) => e !== entry && e.port !== null)
                .map((e) => e.port as number),
            );
          yield* provide(
            Effect.gen(function* () {
              let backoff = 5_000;
              while (true) {
                const result = yield* ensureHttpContainer(
                  { server: def.name, image: r.image, args: r.args, env, targetPort: r.targetPort },
                  reserved(),
                ).pipe(Effect.result);
                if (result._tag === "Success") {
                  entry.port = result.success.port;
                  if (result.success.adopted)
                    yield* Effect.logInfo(
                      `hub: adopted ${containerName(def.name)} on port ${entry.port}`,
                    );
                  yield* check(entry).pipe(
                    Effect.delay(Duration.seconds(result.success.adopted ? 0 : 2)),
                    Effect.forkIn(scope),
                  );
                  const startedAt = yield* Clock.currentTimeMillis;
                  // Watch until it stops.
                  while (true) {
                    yield* Effect.sleep(Duration.seconds(15));
                    const now = yield* inspect(containerName(def.name));
                    if (now === null || !now.running) {
                      yield* setState(
                        entry,
                        "error",
                        `${containerName(def.name)} ${now === null ? "is gone" : `stopped (${now.status})`}; restarting`,
                      );
                      break;
                    }
                  }
                  if ((yield* Clock.currentTimeMillis) - startedAt > 10 * 60_000) backoff = 5_000;
                } else {
                  yield* setState(entry, "error", result.failure);
                }
                entry.port = null;
                yield* Effect.sleep(Duration.millis(backoff));
                backoff = Math.min(backoff * 2, 5 * 60_000);
              }
            }).pipe(Effect.forkIn(scope)),
          );
        } else {
          yield* check(entry).pipe(
            Effect.delay(Duration.millis(r.type === "remote" || r.type === "port" ? 0 : 500)),
            Effect.forkIn(scope),
          );
        }
      });

    const stop = (entry: Entry, remove: boolean) =>
      Effect.gen(function* () {
        if (entries.get(entry.def.name) === entry) entries.delete(entry.def.name);
        yield* Scope.close(entry.scope, Exit.void);
        if (remove && entry.def.runner.type === "docker-http")
          yield* removeContainer(containerName(entry.def.name)).pipe(Effect.provide(services));
      });

    /** Stop a container server and start it again, unless something replaced it meanwhile. */
    const restartContainer = (entry: Entry) =>
      Effect.gen(function* () {
        if (entries.get(entry.def.name) !== entry) return;
        yield* stop(entry, true);
        yield* start(entry.def, entry.key);
      }).pipe(lifecycle.withPermit);

    /** Bring the running servers in line with the repo's definitions. */
    const reload = Effect.gen(function* () {
      const now =
        config.serving === undefined
          ? { enabled: config.enabled, ports: config.ports }
          : yield* config.serving;
      const loaded = now.enabled
        ? yield* loadDefinitions(config.repo).pipe(Effect.provide(services))
        : { definitions: [], problems: [] };
      problems = loaded.problems;
      const wanted = new Map<string, HubDefinition>(loaded.definitions.map((d) => [d.name, d]));
      for (const [name, port] of Object.entries(now.ports))
        if (!wanted.has(name)) wanted.set(name, portDefinition(name, port));
      const secretValues = yield* secrets;
      // Deleting the current key while iterating a Map is safe.
      for (const [name, entry] of entries) {
        if (!wanted.has(name)) {
          yield* Effect.logInfo(`hub: ${name} is no longer defined; stopping it`);
          yield* stop(entry, true);
        }
      }
      for (const def of wanted.values()) {
        const key = toJson([
          def,
          "env" in def.runner ? resolvedEnv(def.runner.env, secretValues) : {},
        ]);
        const existing = entries.get(def.name);
        if (existing !== undefined && existing.key === key) continue;
        if (existing !== undefined) {
          yield* Effect.logInfo(`hub: ${def.name} changed; restarting it`);
          yield* stop(existing, false);
        }
        yield* start(def, key);
      }
    }).pipe(lifecycle.withPermit);

    // ── health ──────────────────────────────────────────────────────────

    /** initialize, then tools/list, through the upstream, as a client would. */
    const handshake = (entry: Entry) =>
      Effect.gen(function* () {
        const accept = "application/json, text/event-stream";
        const init = yield* entry.probe.forward({
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept,
            "mcp-protocol-version": "2025-06-18",
          },
          body: toJson({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "t3-fleet-hub", version: config.version },
            },
          }),
        });
        const initText = yield* readBody(init).pipe(Effect.orElseSucceed(() => ""));
        if (init.status < 200 || init.status >= 300)
          return yield* new UpstreamError({ message: `initialize answered HTTP ${init.status}` });
        const initReply = messagesInBody(init.headers["content-type"], initText).find((m) =>
          isResponse(m),
        );
        if (initReply === undefined)
          return yield* new UpstreamError({ message: "initialize got no answer" });
        if (initReply.error != null)
          return yield* new UpstreamError({
            message: `initialize failed: ${errorText(initReply.error)}`,
          });
        if (Option.isNone(decodeInitializeResult(initReply.result)))
          return yield* new UpstreamError({
            message: "initialize answered without a protocol version",
          });
        const session = init.headers["mcp-session-id"];
        const headers = {
          "content-type": "application/json",
          accept,
          "mcp-protocol-version": "2025-06-18",
          ...(session === undefined ? {} : { "mcp-session-id": session }),
        };
        yield* entry.probe
          .forward({
            method: "POST",
            headers,
            body: toJson({ jsonrpc: "2.0", method: "notifications/initialized" }),
          })
          .pipe(
            Effect.flatMap((r) => readBody(r)),
            Effect.ignore,
          );
        const list = yield* entry.probe.forward({
          method: "POST",
          headers,
          body: toJson({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
        const listText = yield* readBody(list).pipe(Effect.orElseSucceed(() => ""));
        const listReply = messagesInBody(list.headers["content-type"], listText).find((m) =>
          isResponse(m),
        );
        if (session !== undefined)
          yield* entry.probe
            .forward({ method: "DELETE", headers, body: "" })
            .pipe(Effect.flatMap(readBody), Effect.ignore);
        return yield* countTools(entry, listReply?.result).pipe(
          Effect.mapError((message) => new UpstreamError({ message })),
        );
      });

    /** The tools a client may call, from a tools/list result; null when the server has none to list. */
    const countTools = (entry: Entry, result: unknown): Effect.Effect<number | null, string> => {
      if (result === undefined) return Effect.succeed(null);
      return Option.match(decodeToolList(result), {
        onNone: () => Effect.fail("tools/list answered something that is not a list of tools"),
        onSome: ({ tools }) =>
          Effect.succeed(tools.filter(isNamedTool).filter((t) => !entry.denied(t.name)).length),
      });
    };

    /** A check got no answer; after a few in a row, the process or container is started again. */
    const missed = (entry: Entry) =>
      Effect.gen(function* () {
        if (entry.bridge === null && entry.def.runner.type !== "docker-http") return;
        // A server working on a client's request may be too busy to answer; that is not a hang.
        if ((yield* entry.clientRequests) > 0) return;
        entry.missed++;
        if (entry.missed < MISSED_CHECKS) return;
        entry.missed = 0;
        yield* Effect.logWarning(
          `hub: ${entry.def.name} missed ${MISSED_CHECKS} health checks in a row; restarting it`,
        );
        if (entry.bridge !== null) yield* entry.bridge.restart;
        // Forked into the hub's scope: stopping the entry closes the scope this check may run in.
        else if (entry.def.runner.type === "docker-http")
          yield* restartContainer(entry).pipe(Effect.forkIn(hubScope));
      });

    const noAnswer = `no answer within ${Duration.format(checkTimeout)}`;

    const checkOnce = (entry: Entry): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (entries.get(entry.def.name) !== entry) return;
        if (entry.bridge !== null) {
          const status = yield* entry.bridge.status;
          if (status.state !== "running") {
            yield* setState(entry, status.state, status.detail);
          } else {
            const list = yield* entry.bridge.request("tools/list").pipe(
              Effect.timeoutOption(checkTimeout),
              Effect.flatMap((o) =>
                o._tag === "Some" ? Effect.succeed(o.value) : Effect.fail(noAnswer),
              ),
              Effect.result,
            );
            if (list._tag === "Failure") {
              yield* setState(entry, "error", list.failure);
              yield* missed(entry);
            } else {
              entry.missed = 0;
              const tools = yield* countTools(entry, list.success.result).pipe(Effect.result);
              entry.tools = tools._tag === "Success" ? tools.success : null;
              yield* setState(
                entry,
                tools._tag === "Success" ? "running" : "error",
                tools._tag === "Success" ? null : tools.failure,
              );
            }
          }
        } else if (entry.def.runner.type === "docker-http" && entry.port === null) {
          // The container supervisor reports its own state.
        } else {
          const result = yield* handshake(entry).pipe(Effect.timeout(checkTimeout), Effect.result);
          if (result._tag === "Success") {
            entry.missed = 0;
            entry.tools = result.success;
            yield* setState(entry, "running", null);
          } else {
            const e = result.failure;
            if (e._tag === "NeedsLogin") yield* setState(entry, "needs-login", e.message);
            else if (e._tag === "TimeoutError") {
              yield* setState(entry, "error", noAnswer);
              yield* missed(entry);
            } else yield* setState(entry, "error", e.message);
          }
        }
        entry.lastCheckAt = yield* Clock.currentTimeMillis;
      });

    /** One server's check, whatever happens in it, never stops another's or the loop. */
    const check = (entry: Entry): Effect.Effect<void> =>
      checkOnce(entry).pipe(
        Effect.catchDefect((defect) =>
          Effect.gen(function* () {
            yield* Effect.logError(`hub: checking ${entry.def.name} failed: ${String(defect)}`);
            yield* setState(entry, "error", "the health check failed; see the relay's log");
            entry.lastCheckAt = yield* Clock.currentTimeMillis;
          }),
        ),
      );

    const checkAll = Effect.gen(function* () {
      yield* reload.pipe(
        Effect.catchCause((cause) =>
          Effect.logError(`hub: reloading definitions failed: ${String(cause)}`),
        ),
      );
      yield* owners.prune;
      yield* Effect.forEach([...entries.values()], check, { concurrency: 8, discard: true });
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError(`hub: the health check failed: ${String(defect)}`),
      ),
    );

    yield* reload;
    yield* checkAll.pipe(
      Effect.delay(checkEvery),
      Effect.repeat(Schedule.spaced(checkEvery)),
      Effect.forkScoped,
    );

    // ── gateway ─────────────────────────────────────────────────────────

    /** The client a bearer token belongs to, or null. */
    const authenticate = (authorization: string | undefined, relayToken: string) =>
      Effect.gen(function* () {
        if (yield* bearerMatches(authorization, relayToken))
          return { client: "relay", servers: null as ReadonlyArray<string> | null };
        const given = bearerOf(authorization);
        if (given === null) return null;
        const digest = yield* hashToken(given);
        let found: { client: string; servers: ReadonlyArray<string> | null } | null = null;
        // Compare against every stored digest so timing does not depend on which one matches.
        for (const [client, t] of Object.entries((yield* store.get).clients))
          if (constantTimeEqual(digest, t.hash)) found = { client, servers: t.servers };
        return found;
      });

    const record = (call: Omit<HubCall, "at">, startedAt: number) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* log.record({ ...call, at: startedAt, durationMs: Math.max(0, now - startedAt) });
      });

    const recordAll = (
      requested: ReadonlyArray<Requested>,
      server: string,
      client: string,
      outcome: HubCall["outcome"],
      error: string | null,
      startedAt: number,
    ) =>
      Effect.forEach(
        requested,
        (r) =>
          record(
            { server, client, method: r.method, tool: r.tool, outcome, error, durationMs: 0 },
            startedAt,
          ),
        { discard: true },
      );

    /** Pass the response through unchanged, recording each request when its response goes by. */
    const logged = (
      response: UpstreamResponse,
      requested: ReadonlyArray<Requested>,
      server: string,
      client: string,
      startedAt: number,
    ): UpstreamResponse => {
      if (requested.length === 0) return response;
      const open = new Map(requested.map((r) => [r.id, r]));
      const decoder = new TextDecoder();
      const sse = isEventStream(response.headers["content-type"]) ? makeSseParser() : null;
      let text = "";
      const seen = (messages: ReadonlyArray<JsonRpcMessage>) =>
        Effect.forEach(
          messages,
          (m) => {
            if (!isResponse(m) || m.id === undefined || m.id === null) return Effect.void;
            const r = open.get(idKey(m.id));
            if (r === undefined) return Effect.void;
            open.delete(r.id);
            return record(
              {
                server,
                client,
                method: r.method,
                tool: r.tool,
                outcome: m.error === undefined ? "ok" : "error",
                error: errorReason(m),
                durationMs: 0,
              },
              startedAt,
            );
          },
          { discard: true },
        );
      const chunk = (bytes: Uint8Array) =>
        Effect.suspend(() => {
          const decoded = decoder.decode(bytes, { stream: true });
          if (sse === null) {
            if (text.length < 4_000_000) text += decoded;
            return Effect.void;
          }
          return seen(sse(decoded).flatMap((e) => parseMessages(e.data)?.messages ?? []));
        });
      const finish = Effect.gen(function* () {
        if (sse === null && text !== "") yield* seen(parseMessages(text)?.messages ?? []);
        const error = response.status >= 400 ? `HTTP ${response.status}` : "no response";
        yield* recordAll([...open.values()], server, client, "error", error, startedAt);
        open.clear();
      });
      return { ...response, body: response.body.pipe(Stream.tap(chunk), Stream.ensuring(finish)) };
    };

    /** Remove denied tools from tools/list results, so clients never see them. */
    const filterToolLists = (
      response: UpstreamResponse,
      requested: ReadonlyArray<Requested>,
      denied: (tool: string) => boolean,
    ) =>
      Effect.gen(function* () {
        const ids = new Set(requested.filter((r) => r.method === "tools/list").map((r) => r.id));
        const text = yield* readBody(response).pipe(Effect.orElseSucceed(() => ""));
        const filter = (m: JsonRpcMessage): JsonRpcMessage => {
          if (!isResponse(m) || m.id == null || !ids.has(idKey(m.id))) return m;
          const result = m.result as { tools?: Array<{ name?: unknown }> } | undefined;
          if (result?.tools === undefined) return m;
          return {
            ...m,
            result: {
              ...result,
              tools: result.tools.filter((t) => typeof t.name !== "string" || !denied(t.name)),
            },
          };
        };
        if (isEventStream(response.headers["content-type"])) {
          const frames = makeSseParser()(`${text}\n\n`).map((e) => {
            const parsed = parseMessages(e.data);
            if (parsed === null)
              return sseFrame(e.data, e.event === null ? {} : { event: e.event });
            const out = parsed.batch
              ? parsed.messages.map(filter)
              : filter(parsed.messages[0] as JsonRpcMessage);
            return sseFrame(toJson(out), {
              event: e.event ?? "message",
              ...(e.id === null ? {} : { id: e.id }),
            });
          });
          return {
            ...response,
            body: Stream.make(new TextEncoder().encode(frames.join(""))),
          } satisfies UpstreamResponse;
        }
        const parsed = parseMessages(text);
        if (parsed === null) return textResponse(response.status, text, response.headers);
        return textResponse(
          response.status,
          toJson(
            parsed.batch
              ? parsed.messages.map(filter)
              : filter(parsed.messages[0] as JsonRpcMessage),
          ),
          response.headers,
        );
      });

    const authorize: Hub["authorize"] = (name, authorization, method) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const who = yield* authenticate(authorization, config.relayToken);
        if (who !== null && (who.servers === null || who.servers.includes(name)))
          return { client: who.client };
        // One record per rejected request, whatever its body would have held: it is never read.
        yield* record(
          {
            server: name,
            client: who?.client ?? "unknown",
            method,
            tool: null,
            outcome: "unauthorized",
            error: who === null ? "bad or missing token" : "token not valid for this server",
            durationMs: 0,
          },
          startedAt,
        );
        return {
          rejected:
            who === null
              ? textResponse(401, "Unauthorized", { "content-type": "text/plain" })
              : textResponse(403, "Forbidden", { "content-type": "text/plain" }),
        };
      });

    const serve: Hub["serve"] = (name, client, request) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const entry = entries.get(name);
        if (entry === undefined)
          return textResponse(404, `No MCP server named ${name}`, { "content-type": "text/plain" });
        const session = request.headers["mcp-session-id"];
        if (session !== undefined && !(yield* owners.owns(name, session, client)))
          return textResponse(404, toJson(errorMessage(null, -32001, "Session not found")));

        const parsed = request.method === "POST" ? parseMessages(request.body) : null;
        if (request.method === "POST" && parsed === null)
          return textResponse(400, toJson(errorMessage(null, -32700, "Parse error")));
        const messages = parsed?.messages ?? [];
        const requests = messages.filter(isRequest);
        const requested: Array<Requested> = requests.map((m) => ({
          id: idKey(m.id as string | number),
          method: String(m.method),
          tool: toolOf(m),
        }));
        const refuse = (
          status: number,
          code: number,
          reason: (r: Requested) => string,
          outcome: (r: Requested) => HubCall["outcome"],
        ) =>
          Effect.gen(function* () {
            for (const r of requested)
              yield* record(
                {
                  server: name,
                  client,
                  method: r.method,
                  tool: r.tool,
                  outcome: outcome(r),
                  error: reason(r),
                  durationMs: 0,
                },
                startedAt,
              );
            const replies = requests.map((m) =>
              errorMessage(
                m.id ?? null,
                code,
                reason(requested.find((r) => r.id === idKey(m.id as string | number)) as Requested),
              ),
            );
            return textResponse(
              status,
              toJson(
                parsed?.batch === true
                  ? replies
                  : (replies[0] ?? errorMessage(null, code, "refused")),
              ),
            );
          });

        // Keys that fold to one the hub reads would let the server see another tool than the policy did.
        if (messages.some((m) => caseVariantKey(m) !== null)) {
          return yield* refuse(
            400,
            -32600,
            () => "T3 Fleet hub: refused a message with keys that differ only in case",
            () => "denied",
          );
        }
        // A tools/call must name its tool plainly.
        const unnamed = requests.some((m) => m.method === "tools/call" && toolOf(m) === null);
        if (unnamed)
          return yield* refuse(
            400,
            -32602,
            () => "T3 Fleet hub: tools/call needs a string params.name",
            () => "denied",
          );

        // Tool policy: a batch with any denied call is refused as a whole. Over-long names are denied.
        const denied = requested.filter((r) => r.tool !== null && entry.denied(r.tool));
        if (denied.length > 0) {
          return yield* refuse(
            200,
            -32003,
            (r) =>
              denied.includes(r)
                ? "T3 Fleet hub: this tool is not allowed on this server"
                : "T3 Fleet hub: refused with a denied tool call in the same batch",
            (r) => (denied.includes(r) ? "denied" : "error"),
          );
        }

        // Forward what the hub checked, rebuilt from the JSON-RPC fields alone, never the raw body.
        const rebuilt = messages.map(rebuildMessage);
        const forward: ForwardRequest =
          parsed === null
            ? request
            : { ...request, body: toJson(parsed.batch ? rebuilt : rebuilt[0]) };
        const result = yield* entry.upstream.forward(forward).pipe(Effect.result);
        if (result._tag === "Failure") {
          const e = result.failure;
          if (e._tag === "NeedsLogin") {
            yield* setState(entry, "needs-login", e.message);
            const message = `T3 Fleet hub: ${name} needs a sign-in (t3-fleet mcp login ${name})`;
            yield* recordAll(requested, name, client, "error", "needs-login", startedAt);
            return jsonRpcFailure(503, message, stateHeaders("needs-login"));
          }
          yield* recordAll(requested, name, client, "error", "upstream unreachable", startedAt);
          return jsonRpcFailure(502, `T3 Fleet hub: ${e.message}`, stateHeaders(entry.state));
        }
        const opened = result.success.headers["mcp-session-id"];
        if (opened !== undefined)
          yield* owners.record(name, opened, client, { expires: entry.bridge === null });
        if (
          session !== undefined &&
          ((request.method === "DELETE" && result.success.status < 300) ||
            result.success.status === 404)
        )
          yield* owners.end(name, session);
        const response =
          entry.def.deny.length > 0 && requested.some((r) => r.method === "tools/list")
            ? yield* filterToolLists(result.success, requested, entry.denied)
            : result.success;
        return logged(response, requested, name, client, startedAt);
      });

    const gateway: Hub["gateway"] = (name, authorization, request) =>
      authorize(name, authorization, request.method).pipe(
        Effect.flatMap((a) =>
          "rejected" in a ? Effect.succeed(a.rejected) : serve(name, a.client, request),
        ),
      );

    // ── management ──────────────────────────────────────────────────────

    const need = (name: string) =>
      Effect.suspend(() => {
        const entry = entries.get(name);
        return entry === undefined
          ? Effect.fail(`no hosted MCP server named ${name}`)
          : Effect.succeed(entry);
      });

    const hub: Hub = {
      servers: Effect.gen(function* () {
        const listed: Array<HubServer> = [];
        for (const e of entries.values()) {
          const auth: HubServer["auth"] =
            e.def.auth.type === "bearer"
              ? "bearer"
              : usesOAuth(e) || (yield* oauth.hasTokens(e.def.name))
                ? "oauth"
                : "none";
          listed.push({
            name: e.def.name,
            kind: e.def.kind,
            upstream: e.def.upstream,
            state: e.state,
            detail: e.detail,
            auth,
            expiresAt: auth === "oauth" ? yield* oauth.expiresAt(e.def.name) : null,
            tools: e.tools,
            lastCheckAt: e.lastCheckAt,
          });
        }
        for (const p of problems)
          listed.push({
            name: p.name,
            kind: "invalid",
            upstream: "",
            state: "error",
            detail: p.problem,
            auth: "none",
            expiresAt: null,
            tools: null,
            lastCheckAt: null,
          });
        return listed.sort((a, b) => a.name.localeCompare(b.name));
      }),
      calls: log.list,
      authorize,
      serve,
      gateway,
      login: (name) =>
        Effect.gen(function* () {
          const entry = yield* need(name);
          if (redirectUri === "")
            return yield* Effect.fail(
              "no [relay] url in t3-fleet.toml; signing in redirects to <relay url>/oauth/callback",
            );
          const r = entry.def.runner;
          const url =
            r.type === "remote"
              ? r.url
              : r.type === "port"
                ? `http://127.0.0.1:${r.port}/mcp`
                : r.type === "docker-http" && entry.port !== null
                  ? `http://127.0.0.1:${entry.port}${r.path}`
                  : null;
          if (url === null)
            return yield* Effect.fail(
              `${name} takes its credentials from its environment, not a sign-in`,
            );
          if (entry.def.auth.type === "bearer")
            return yield* Effect.fail(
              `${name} uses the secret ${entry.def.auth.tokenEnv}, not a sign-in`,
            );
          const def: HubDefinition =
            entry.def.auth.type === "oauth"
              ? entry.def
              : { ...entry.def, auth: { type: "oauth", scopes: [], client: null } };
          return yield* oauth
            .start(def, url, entry.challenge)
            .pipe(Effect.mapError((e) => e.message));
        }),
      finishLogin: (query) =>
        Effect.gen(function* () {
          const name = yield* oauth.finish(query).pipe(Effect.mapError((e) => e.message));
          const entry = entries.get(name);
          if (entry !== undefined) {
            entry.oauthDetected = true;
            yield* setState(entry, "starting", "signed in; checking");
            yield* check(entry).pipe(Effect.forkIn(entry.scope));
          }
          return name;
        }),
      loginStatus: oauth.loginStatus,
      logout: (name) =>
        Effect.gen(function* () {
          const entry = yield* need(name);
          yield* oauth.forget(name);
          if (usesOAuth(entry)) yield* setState(entry, "needs-login", "signed out");
        }),
      restart: (name) =>
        Effect.gen(function* () {
          const entry = yield* need(name);
          if (entry.bridge !== null) yield* entry.bridge.restart;
          else if (entry.def.runner.type === "docker-http") {
            yield* restartContainer(entry);
            return;
          }
          yield* check(entry).pipe(Effect.delay(Duration.seconds(1)), Effect.forkIn(entry.scope));
        }),
      createToken: (client, servers) =>
        Effect.gen(function* () {
          if (!CLIENT_PATTERN.test(client) || client === "relay")
            return yield* Effect.fail(
              'client names are lowercase letters, digits, - and _ (and not "relay")',
            );
          const token = newClientToken();
          const hash = yield* hashToken(token);
          const createdAt = yield* Clock.currentTimeMillis;
          yield* store.update((s) => [
            undefined,
            { ...s, clients: { ...s.clients, [client]: { hash, servers, createdAt } } },
          ]);
          return token;
        }),
      listTokens: store.get.pipe(
        Effect.map((s) =>
          Object.entries(s.clients)
            .map(([client, t]) => ({ client, servers: t.servers, createdAt: t.createdAt }))
            .sort((a, b) => a.client.localeCompare(b.client)),
        ),
      ),
      revokeToken: (client) =>
        store.update((s) => {
          if (s.clients[client] === undefined) return [false, s];
          const clients = { ...s.clients };
          delete clients[client];
          return [true, { ...s, clients }];
        }),
      check: (name) =>
        name === undefined
          ? checkAll
          : Effect.suspend(() => {
              const entry = entries.get(name);
              return entry === undefined ? Effect.void : check(entry);
            }),
    };
    return hub;
  });
