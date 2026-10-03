/**
 * The stdio bridge: one stdio MCP process, many streamable-HTTP clients.
 *
 * A stdio server speaks to exactly one client, so the bridge is that client
 * and multiplexes everyone else onto it:
 *
 *   initialize    the bridge initializes the process itself, once per process
 *                 start, and answers every client's initialize from that
 *                 cached result, with a fresh Mcp-Session-Id per client
 *   requests      ids are rewritten to the bridge's own, so two clients may
 *                 both send id 1; responses go back under the client's id to
 *                 the POST that asked
 *   progress      a request's progressToken is rewritten the same way, so
 *                 progress reaches only the client that asked for it
 *   cancellation  notifications/cancelled has its requestId mapped
 *   notifications list_changed and resources/updated fan out to every
 *                 client's GET stream; log messages go only to the client
 *                 whose request is in flight (dropped when that is unclear)
 *   sessions      belong to the client that opened them; the gateway
 *                 refuses another client's session id
 *
 * The bridge declares no client capabilities, so a server never sends it
 * sampling, elicitation or roots requests; if one does, the bridge answers
 * "method not found" itself.
 *
 * When the process exits, outstanding requests get an error, sessions stay
 * valid, and the process is started again with backoff and re-initialized.
 */
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  errorMessage,
  idKey,
  isNotification,
  isRequest,
  isResponse,
  parseMessages,
  sseFrame,
  toJson,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./JsonRpc.ts";
import { randomSecret } from "./Policy.ts";
import { textResponse, type ForwardRequest, type Upstream, type UpstreamResponse } from "./Upstream.ts";

/** A running stdio process: lines in, lines out. */
export interface StdioProcess {
  readonly write: (line: string) => Effect.Effect<void>;
  readonly lines: Stream.Stream<string>;
  /** Resolves when the process has exited, with a short reason. */
  readonly exited: Effect.Effect<string>;
}

export type BridgeStatus =
  | { readonly state: "starting"; readonly detail: string | null }
  | { readonly state: "running"; readonly detail: null }
  | { readonly state: "error"; readonly detail: string };

export const PROTOCOL_VERSION = "2025-06-18";

interface Pending {
  readonly session: string | null;
  readonly clientId: JsonRpcId;
  readonly deliver: (message: JsonRpcMessage) => Effect.Effect<void>;
  readonly progressToken: { readonly bridge: string; readonly client: unknown } | null;
}

interface Session {
  readonly id: string;
  stream: Queue.Queue<string, Cause.Done> | null;
  lastSeen: number;
}

/** Notifications every client may see: they say the server changed, not what a client asked. */
const isBroadcast = (method: string | undefined) => method !== undefined && (method.endsWith("/list_changed") || method === "notifications/resources/updated");

const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 5 * 60_000;
const SESSION_IDLE = 24 * 60 * 60_000;
const MAX_SESSIONS = 1000;
const REQUEST_TIMEOUT = Duration.minutes(10);

export interface Bridge extends Upstream {
  readonly status: Effect.Effect<BridgeStatus>;
  /** Kill the process; the supervisor starts a fresh one. */
  readonly restart: Effect.Effect<void>;
  /** A request from the bridge itself (health checks), outside any session. */
  readonly request: (method: string, params?: unknown) => Effect.Effect<JsonRpcMessage, string>;
}

/**
 * Supervise `spawn` and bridge it. The supervisor lives in the caller's scope:
 * closing it stops the process for good.
 */
export const makeBridge = (options: {
  readonly name: string;
  readonly spawn: Effect.Effect<StdioProcess, string, Scope.Scope>;
  readonly version?: string;
  /** Called whenever the status changes. */
  readonly onStatus?: (status: BridgeStatus) => Effect.Effect<void>;
}): Effect.Effect<Bridge, never, Scope.Scope> =>
  Effect.gen(function* () {
    let status: BridgeStatus = { state: "starting", detail: null };
    const setStatus = (next: BridgeStatus) =>
      Effect.suspend(() => {
        const changed = next.state !== status.state || next.detail !== status.detail;
        status = next;
        return changed && options.onStatus !== undefined ? options.onStatus(next) : Effect.void;
      });
    let nextId = 1;
    const pending = new Map<string, Pending>();
    const progress = new Map<string, string>(); // bridge token → pending key
    const sessions = new Map<string, Session>();
    let current: StdioProcess | null = null;
    let initialized: Deferred.Deferred<JsonRpcMessage, string> = yield* Deferred.make<JsonRpcMessage, string>();
    let kill: Deferred.Deferred<void> = yield* Deferred.make<void>();

    const failAll = (reason: string) =>
      Effect.forEach(
        [...pending.entries()],
        ([key, p]) => {
          pending.delete(key);
          if (p.progressToken !== null) progress.delete(p.progressToken.bridge);
          return p.deliver(errorMessage(p.clientId, -32603, reason));
        },
        { discard: true },
      );

    const broadcast = (message: JsonRpcMessage) =>
      Effect.forEach(
        [...sessions.values()],
        (s) => (s.stream === null ? Effect.void : Queue.offer(s.stream, sseFrame(toJson(message), { event: "message" })).pipe(Effect.asVoid)),
        { discard: true },
      );

    /** One line from the process. */
    const dispatch = (line: string, process: StdioProcess) =>
      Effect.gen(function* () {
        const parsed = parseMessages(line);
        if (parsed === null) return;
        for (const message of parsed.messages) {
          if (isResponse(message) && message.id !== undefined && message.id !== null) {
            const key = idKey(message.id);
            const p = pending.get(key);
            if (p === undefined) continue;
            pending.delete(key);
            if (p.progressToken !== null) progress.delete(p.progressToken.bridge);
            const { id: _, ...rest } = message;
            yield* p.deliver({ ...rest, id: p.clientId });
          } else if (isRequest(message)) {
            yield* process.write(toJson(errorMessage(message.id ?? null, -32601, `the fleetx hub does not offer ${message.method ?? "this method"} to servers`)));
          } else if (isNotification(message)) {
            const params = message.params as { progressToken?: unknown } | undefined;
            if (message.method === "notifications/progress" && params?.progressToken !== undefined) {
              const key = progress.get(String(params.progressToken));
              const p = key === undefined ? undefined : pending.get(key);
              if (p?.progressToken != null) yield* p.deliver({ ...message, params: { ...params, progressToken: p.progressToken.client } });
            } else if (isBroadcast(message.method)) {
              yield* broadcast(message);
            } else {
              // Log messages and the like may describe one client's request: only that client gets them,
              // and only when exactly one session has a request in flight. Otherwise they are dropped.
              const inFlight = [...pending.values()].filter((p) => p.session !== null);
              const owners = new Set(inFlight.map((p) => p.session));
              const latest = inFlight.at(-1);
              if (owners.size === 1 && latest !== undefined) yield* latest.deliver(message);
            }
          }
        }
      });

    const send = (message: JsonRpcMessage, entry: Omit<Pending, "progressToken"> | null) =>
      Effect.gen(function* () {
        const process = current;
        if (process === null) return yield* Effect.fail("the server is not running");
        if (entry === null || !isRequest(message)) {
          yield* process.write(toJson(message));
          return;
        }
        const bridgeId = nextId++;
        let progressToken: Pending["progressToken"] = null;
        let params = message.params;
        const meta = (params as { _meta?: { progressToken?: unknown } } | undefined)?._meta;
        if (meta?.progressToken !== undefined) {
          progressToken = { bridge: `fxp-${bridgeId}`, client: meta.progressToken };
          params = { ...(params as object), _meta: { ...meta, progressToken: progressToken.bridge } };
          progress.set(progressToken.bridge, idKey(bridgeId));
        }
        pending.set(idKey(bridgeId), { ...entry, progressToken });
        yield* process.write(toJson({ ...message, id: bridgeId, ...(params === undefined ? {} : { params }) }));
      });

    /** A request from the bridge itself; resolves with the response. */
    const ownRequest = (method: string, params?: unknown): Effect.Effect<JsonRpcMessage, string> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<JsonRpcMessage>();
        yield* send(
          { jsonrpc: "2.0", id: 0, method, ...(params === undefined ? {} : { params }) },
          { session: null, clientId: 0, deliver: (m) => Deferred.succeed(done, m).pipe(Effect.asVoid) },
        );
        return yield* Deferred.await(done).pipe(
          Effect.timeoutOption(Duration.seconds(30)),
          Effect.flatMap((o) => (o._tag === "Some" ? Effect.succeed(o.value) : Effect.fail(`${method} got no answer within 30s`))),
        );
      });

    // The supervisor: start, initialize, read until exit, back off, again.
    const runOnce: Effect.Effect<{ readonly why: string; readonly startedAt: number }, string> = Effect.scoped(
      Effect.gen(function* () {
        yield* setStatus({ state: "starting", detail: status.state === "error" ? status.detail : null });
        const process = yield* options.spawn;
        current = process;
        const reader = yield* process.lines.pipe(
          Stream.runForEach((line) => dispatch(line, process)),
          Effect.forkScoped,
        );
        const early: Effect.Effect<never, string> = process.exited.pipe(Effect.flatMap((why) => Effect.fail(`exited before answering initialize: ${why}`)));
        const init = yield* Effect.raceFirst(
          ownRequest("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "fleetx-hub", version: options.version ?? "1" },
          }),
          early,
        );
        if (init.error !== undefined) return yield* Effect.fail(`initialize failed: ${init.error.message}`);
        yield* process.write(toJson({ jsonrpc: "2.0", method: "notifications/initialized" }));
        yield* Deferred.succeed(initialized, init);
        yield* setStatus({ state: "running", detail: null });
        const startedAt = yield* Clock.currentTimeMillis;
        const why = yield* process.exited.pipe(Effect.raceFirst(Deferred.await(kill).pipe(Effect.as("restarted"))));
        yield* Fiber.interrupt(reader);
        return { why, startedAt };
      }),
    );

    yield* Effect.gen(function* () {
      let backoff = BACKOFF_MIN;
      while (true) {
        const result = yield* runOnce.pipe(Effect.result);
        current = null;
        const reason = result._tag === "Success" ? `exited (${result.success.why})` : result.failure;
        const stayedUp = result._tag === "Success" && (yield* Clock.currentTimeMillis) - result.success.startedAt > 60_000;
        const killed = result._tag === "Success" && result.success.why === "restarted";
        yield* failAll(`${options.name} stopped: ${reason}`);
        initialized = yield* Deferred.make<JsonRpcMessage, string>();
        kill = yield* Deferred.make<void>();
        if (killed || stayedUp) backoff = BACKOFF_MIN;
        yield* setStatus(killed ? { state: "starting", detail: null } : { state: "error", detail: reason });
        if (!killed) yield* Effect.logWarning(`hub: ${options.name} ${reason}; restarting in ${Math.round(backoff / 1000)}s`);
        yield* Effect.sleep(killed ? 0 : backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
      }
    }).pipe(Effect.forkScoped);

    const pruneSessions = (now: number) => {
      for (const [id, s] of sessions) if (s.stream === null && now - s.lastSeen > SESSION_IDLE) sessions.delete(id);
    };

    const sessionOf = (request: ForwardRequest) => {
      const id = request.headers["mcp-session-id"];
      return id === undefined ? undefined : sessions.get(id);
    };

    const notFound = textResponse(404, toJson(errorMessage(null, -32001, "Session not found")));
    const badRequest = (message: string) => textResponse(400, toJson(errorMessage(null, -32600, message)));

    const post = (request: ForwardRequest): Effect.Effect<UpstreamResponse> =>
      Effect.gen(function* () {
        const parsed = parseMessages(request.body);
        if (parsed === null) return textResponse(400, toJson(errorMessage(null, -32700, "Parse error")));
        const now = yield* Clock.currentTimeMillis;
        const init = parsed.messages.find((m) => m.method === "initialize" && isRequest(m));
        let session = sessionOf(request);
        if (init !== undefined) {
          if (parsed.messages.length > 1) return badRequest("initialize must be sent alone");
          const result = yield* Deferred.await(initialized).pipe(Effect.timeoutOption(Duration.seconds(30)), Effect.result);
          if (result._tag === "Failure" || result.success._tag === "None") {
            return textResponse(200, toJson(errorMessage(init.id ?? null, -32603, `${options.name} is not ready: ${status.detail ?? "starting"}`)));
          }
          pruneSessions(now);
          if (sessions.size >= MAX_SESSIONS) return textResponse(503, toJson(errorMessage(init.id ?? null, -32603, "too many sessions")));
          const id = randomSecret();
          sessions.set(id, { id, stream: null, lastSeen: now });
          const { id: _, ...rest } = result.success.value;
          return textResponse(200, toJson({ ...rest, id: init.id ?? null }), { "mcp-session-id": id, "mcp-protocol-version": PROTOCOL_VERSION });
        }
        if (request.headers["mcp-session-id"] === undefined) return badRequest("Mcp-Session-Id header is required");
        if (session === undefined) return notFound;
        session.lastSeen = now;
        const sessionId = session.id;

        const requests = parsed.messages.filter(isRequest);
        // Client notifications: initialized was sent by the bridge; cancellations need their id mapped.
        for (const m of parsed.messages.filter(isNotification)) {
          if (m.method === "notifications/initialized") continue;
          if (m.method === "notifications/cancelled") {
            const target = (m.params as { requestId?: JsonRpcId } | undefined)?.requestId;
            const match = [...pending.entries()].find(([, p]) => p.session === sessionId && target !== undefined && idKey(p.clientId) === idKey(target));
            if (match === undefined) continue;
            const bridgeId = Number(match[0].slice(match[0].indexOf(":") + 1));
            yield* send({ ...m, params: { ...(m.params as object), requestId: bridgeId } }, null).pipe(Effect.ignore);
            continue;
          }
          yield* send(m, null).pipe(Effect.ignore);
        }
        if (requests.length === 0) return { status: 202, headers: {}, body: Stream.empty };

        const out = yield* Queue.make<JsonRpcMessage, Cause.Done>();
        let remaining = requests.length;
        const deliver = (m: JsonRpcMessage) =>
          Effect.gen(function* () {
            yield* Queue.offer(out, m);
            if (isResponse(m) && --remaining === 0) yield* Queue.end(out);
          });
        for (const m of requests) {
          const sent = yield* send(m, { session: sessionId, clientId: m.id as JsonRpcId, deliver }).pipe(Effect.result);
          if (sent._tag === "Failure") yield* deliver(errorMessage(m.id ?? null, -32603, `${options.name}: ${sent.failure}`));
        }
        const messages = Stream.fromQueue(out).pipe(Stream.timeout(REQUEST_TIMEOUT));
        const wantsSse = (request.headers["accept"] ?? "").includes("text/event-stream");
        if (wantsSse) {
          return {
            status: 200,
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            body: messages.pipe(
              Stream.map((m) => sseFrame(toJson(m), { event: "message" })),
              Stream.encodeText,
            ),
          };
        }
        const responses = (yield* Stream.runCollect(messages)).filter(isResponse);
        const body = parsed.batch ? toJson(responses) : toJson(responses[0] ?? errorMessage(requests[0]?.id ?? null, -32603, "no response"));
        return textResponse(200, body);
      });

    const get = (request: ForwardRequest): Effect.Effect<UpstreamResponse> =>
      Effect.gen(function* () {
        if (request.headers["mcp-session-id"] === undefined) return badRequest("Mcp-Session-Id header is required");
        const session = sessionOf(request);
        if (session === undefined) return notFound;
        if (session.stream !== null) yield* Queue.end(session.stream);
        const stream = yield* Queue.make<string, Cause.Done>({ capacity: 256, strategy: "sliding" });
        session.stream = stream;
        const keepalive = Stream.tick(Duration.seconds(25)).pipe(Stream.map(() => ": keepalive\n\n"));
        return {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          body: Stream.fromQueue(stream).pipe(
            Stream.merge(keepalive, { haltStrategy: "left" }),
            Stream.ensuring(
              Effect.sync(() => {
                if (session.stream === stream) session.stream = null;
              }),
            ),
            Stream.encodeText,
          ),
        };
      });

    const bridge: Bridge = {
      forward: (request) =>
        request.method === "POST"
          ? post(request)
          : request.method === "GET"
            ? get(request)
            : Effect.gen(function* () {
                const session = sessionOf(request);
                if (session === undefined) return notFound;
                if (session.stream !== null) yield* Queue.end(session.stream);
                sessions.delete(session.id);
                return { status: 204, headers: {}, body: Stream.empty };
              }),
      status: Effect.sync(() => status),
      restart: Effect.suspend(() => Deferred.succeed(kill, undefined)).pipe(Effect.asVoid),
      request: (method, params) =>
        Deferred.await(initialized).pipe(
          Effect.timeoutOption(Duration.seconds(30)),
          Effect.flatMap((o) => (o._tag === "Some" ? ownRequest(method, params) : Effect.fail(`${options.name} is not ready`))),
        ),
    };
    return bridge;
  });
