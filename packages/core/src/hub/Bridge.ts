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
 *                 refuses another client's session id. Clients rarely end
 *                 theirs, so at 1000 sessions a new one replaces the least
 *                 recently seen idle one instead of being refused; one
 *                 without an open GET stream also expires after a day unused
 *   giving up     a request whose client went away, or that heard nothing
 *                 for 10 minutes (progress counts), gets an error, and the
 *                 server gets notifications/cancelled
 *
 * The bridge declares no client capabilities, so a server never sends it
 * sampling, elicitation or roots requests; if one does, the bridge answers
 * "method not found" itself. A ping gets the empty result the spec asks for.
 *
 * When the process exits, outstanding requests get an error, sessions stay
 * valid, and the process is started again with backoff and re-initialized.
 * When the bridge's scope closes, outstanding requests get an error, every
 * session ends, and later requests are refused at once.
 */
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
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
  readonly method: string;
  /** When the request was sent, or last reported progress. */
  lastHeard: number;
}

interface Session {
  readonly id: string;
  stream: Queue.Queue<string, Cause.Done> | null;
  lastSeen: number;
}

/** Notifications every client may see: they say the server changed, not what a client asked. */
const isBroadcast = (method: string | undefined) => method !== undefined && (method.endsWith("/list_changed") || method === "notifications/resources/updated");

/** The part of an initialize result the bridge relies on. */
const decodeInitializeResult = Schema.decodeUnknownOption(Schema.Struct({ protocolVersion: Schema.String }));

const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 5 * 60_000;
const SESSION_IDLE = Duration.hours(24);
const MAX_SESSIONS = 1000;
const REQUEST_TIMEOUT = Duration.minutes(10);

export interface Bridge extends Upstream {
  readonly status: Effect.Effect<BridgeStatus>;
  /** Kill the process; the supervisor starts a fresh one. */
  readonly restart: Effect.Effect<void>;
  /** Client requests the server has not answered yet. */
  readonly clientRequests: Effect.Effect<number>;
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
  /** Called when a session ends: deleted, expired, evicted, or the bridge stopped. */
  readonly onSessionEnd?: (id: string) => Effect.Effect<void>;
  /** How long a session without an open stream lives unused; default a day. */
  readonly sessionIdle?: Duration.Input;
  /** How long a request may go without a word from the server; default 10 minutes. */
  readonly requestTimeout?: Duration.Input;
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
    let stopped = false;
    const sessionIdle = Duration.toMillis(Duration.fromInputUnsafe(options.sessionIdle ?? SESSION_IDLE));
    const requestTimeout = Duration.fromInputUnsafe(options.requestTimeout ?? REQUEST_TIMEOUT);

    const forget = (key: string) => {
      const p = pending.get(key);
      pending.delete(key);
      if (p?.progressToken != null) progress.delete(p.progressToken.bridge);
      return p;
    };

    const failAll = (reason: string) =>
      Effect.forEach(
        [...pending.keys()],
        (key) => {
          const p = forget(key);
          return p === undefined ? Effect.void : p.deliver(errorMessage(p.clientId, -32603, reason));
        },
        { discard: true },
      );

    /**
     * Give up on requests: whoever still waits gets an error, and the server is
     * told to stop working on them (never for initialize, which the spec
     * forbids cancelling).
     */
    const abandon = (keys: ReadonlyArray<string>, reason: string) =>
      Effect.forEach(
        keys,
        (key) =>
          Effect.gen(function* () {
            const p = forget(key);
            if (p === undefined) return;
            yield* p.deliver(errorMessage(p.clientId, -32603, `${options.name}: ${reason}`));
            if (current === null || p.method === "initialize") return;
            const requestId = Number(key.slice(key.indexOf(":") + 1));
            yield* current.write(toJson({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason } }));
          }),
        { discard: true },
      );

    /** Sessions with a request in flight. */
    const busySessions = () => new Set([...pending.values()].map((p) => p.session));

    const endSession = (s: Session) =>
      Effect.gen(function* () {
        if (sessions.get(s.id) !== s) return;
        sessions.delete(s.id);
        if (s.stream !== null) yield* Queue.end(s.stream);
        if (options.onSessionEnd !== undefined) yield* options.onSessionEnd(s.id);
      });

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
            const p = forget(key);
            if (p === undefined) continue;
            const { id: _, ...rest } = message;
            yield* p.deliver({ ...rest, id: p.clientId });
          } else if (isRequest(message) && message.method === "ping") {
            yield* process.write(toJson({ jsonrpc: "2.0", id: message.id ?? null, result: {} }));
          } else if (isRequest(message)) {
            yield* process.write(toJson(errorMessage(message.id ?? null, -32601, `the T3 Fleet hub does not offer ${message.method ?? "this method"} to servers`)));
          } else if (isNotification(message)) {
            const params = message.params as { progressToken?: unknown } | undefined;
            if (message.method === "notifications/progress" && params?.progressToken !== undefined) {
              const key = progress.get(String(params.progressToken));
              const p = key === undefined ? undefined : pending.get(key);
              if (p !== undefined) p.lastHeard = yield* Clock.currentTimeMillis;
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

    /** Write a message to the process; a request is remembered under the returned key until answered. */
    const send = (message: JsonRpcMessage, entry: Omit<Pending, "progressToken" | "method" | "lastHeard"> | null) =>
      Effect.gen(function* () {
        if (stopped) return yield* Effect.fail("the hub stopped serving it");
        const process = current;
        if (process === null) return yield* Effect.fail("the server is not running");
        if (entry === null || !isRequest(message)) {
          yield* process.write(toJson(message));
          return null;
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
        const key = idKey(bridgeId);
        pending.set(key, { ...entry, progressToken, method: message.method ?? "", lastHeard: yield* Clock.currentTimeMillis });
        yield* process.write(toJson({ ...message, id: bridgeId, ...(params === undefined ? {} : { params }) }));
        return key;
      });

    /** A request from the bridge itself; resolves with the response. */
    const ownRequest = (method: string, params?: unknown): Effect.Effect<JsonRpcMessage, string> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<JsonRpcMessage>();
        const key = yield* send(
          { jsonrpc: "2.0", id: 0, method, ...(params === undefined ? {} : { params }) },
          { session: null, clientId: 0, deliver: (m) => Deferred.succeed(done, m).pipe(Effect.asVoid) },
        );
        return yield* Deferred.await(done).pipe(
          Effect.timeoutOption(Duration.seconds(30)),
          Effect.flatMap((o) => (o._tag === "Some" ? Effect.succeed(o.value) : Effect.fail(`${method} got no answer within 30s`))),
          Effect.ensuring(abandon(key === null ? [] : [key], `${method} timed out`)),
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
            clientInfo: { name: "t3-fleet-hub", version: options.version ?? "1" },
          }),
          early,
        );
        if (init.error != null) return yield* Effect.fail(`initialize failed: ${String((init.error as { message?: unknown }).message).slice(0, 200)}`);
        if (Option.isNone(decodeInitializeResult(init.result))) return yield* Effect.fail("initialize answered without a protocol version");
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
        // A defect (a server answering something unexpected) is one more failed start, never the end of the supervisor.
        const result = yield* runOnce.pipe(
          Effect.catchDefect((defect) => Effect.fail(`failed: ${String(defect)}`)),
          Effect.result,
        );
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

    // Runs before the supervisor is interrupted: nothing may keep waiting on a bridge that is gone.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopped = true;
        current = null;
        yield* Deferred.fail(initialized, `${options.name} stopped`);
        yield* failAll(`${options.name} stopped`);
        yield* Effect.forEach([...sessions.values()], endSession, { discard: true });
      }),
    );

    /** Unused for a day, with no open stream and nothing in flight. */
    const expired = (s: Session, now: number, busy: ReadonlySet<string | null>) => s.stream === null && !busy.has(s.id) && now - s.lastSeen > sessionIdle;

    const expire = (now: number) =>
      Effect.gen(function* () {
        const busy = busySessions();
        for (const s of sessions.values()) if (expired(s, now, busy)) yield* endSession(s);
      });

    /**
     * At the cap, end the least recently seen session with nothing in flight,
     * preferring one without a stream. When every session is busy, the cap
     * gives way: a new session is never refused.
     */
    const makeRoom = (now: number) =>
      Effect.gen(function* () {
        yield* expire(now);
        const busy = busySessions();
        while (sessions.size >= MAX_SESSIONS) {
          const idle = [...sessions.values()].filter((s) => !busy.has(s.id));
          const streamless = idle.filter((s) => s.stream === null);
          const candidates = streamless.length > 0 ? streamless : idle;
          if (candidates.length === 0) break;
          yield* endSession(candidates.reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a)));
        }
      });

    // Every minute: end idle sessions, and give up on requests that heard nothing for 10 minutes.
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* expire(now);
      const stale = [...pending.entries()].filter(([, p]) => now - p.lastHeard > Duration.toMillis(requestTimeout)).map(([key]) => key);
      yield* abandon(stale, `no answer within ${Duration.format(requestTimeout)}`);
    }).pipe(Effect.delay(Duration.min(Duration.minutes(1), Duration.divideUnsafe(requestTimeout, 2))), Effect.forever, Effect.forkScoped);

    const sessionOf = (request: ForwardRequest) =>
      Effect.gen(function* () {
        const id = request.headers["mcp-session-id"];
        const s = id === undefined ? undefined : sessions.get(id);
        if (s === undefined) return undefined;
        if (expired(s, yield* Clock.currentTimeMillis, busySessions())) {
          yield* endSession(s);
          return undefined;
        }
        return s;
      });

    const notFound = textResponse(404, toJson(errorMessage(null, -32001, "Session not found")));
    const badRequest = (message: string) => textResponse(400, toJson(errorMessage(null, -32600, message)));

    const post = (request: ForwardRequest): Effect.Effect<UpstreamResponse> =>
      Effect.gen(function* () {
        const parsed = parseMessages(request.body);
        if (parsed === null) return textResponse(400, toJson(errorMessage(null, -32700, "Parse error")));
        const now = yield* Clock.currentTimeMillis;
        const init = parsed.messages.find((m) => m.method === "initialize" && isRequest(m));
        if (init !== undefined) {
          if (parsed.messages.length > 1) return badRequest("initialize must be sent alone");
          const result = yield* Deferred.await(initialized).pipe(Effect.timeoutOption(Duration.seconds(30)), Effect.result);
          if (result._tag === "Failure" || result.success._tag === "None") {
            return textResponse(200, toJson(errorMessage(init.id ?? null, -32603, `${options.name} is not ready: ${status.detail ?? "starting"}`)));
          }
          yield* makeRoom(now);
          const id = randomSecret();
          sessions.set(id, { id, stream: null, lastSeen: now });
          const { id: _, ...rest } = result.success.value;
          return textResponse(200, toJson({ ...rest, id: init.id ?? null }), { "mcp-session-id": id, "mcp-protocol-version": PROTOCOL_VERSION });
        }
        if (request.headers["mcp-session-id"] === undefined) return badRequest("Mcp-Session-Id header is required");
        const session = yield* sessionOf(request);
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
        const keys: Array<string> = [];
        for (const m of requests) {
          const sent = yield* send(m, { session: sessionId, clientId: m.id as JsonRpcId, deliver }).pipe(Effect.result);
          if (sent._tag === "Failure") yield* deliver(errorMessage(m.id ?? null, -32603, `${options.name}: ${sent.failure}`));
          else if (sent.success !== null) keys.push(sent.success);
        }
        // However the response ends (answered, timed out, or its client gone), nothing stays pending.
        const messages = Stream.fromQueue(out).pipe(Stream.timeout(requestTimeout), Stream.ensuring(abandon(keys, "the client stopped waiting")));
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
        const session = yield* sessionOf(request);
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
              Effect.gen(function* () {
                // Idle time counts from when the stream closed.
                if (session.stream === stream) session.stream = null;
                session.lastSeen = yield* Clock.currentTimeMillis;
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
                const session = yield* sessionOf(request);
                if (session === undefined) return notFound;
                yield* endSession(session);
                return { status: 204, headers: {}, body: Stream.empty };
              }),
      status: Effect.sync(() => status),
      restart: Effect.suspend(() => Deferred.succeed(kill, undefined)).pipe(Effect.asVoid),
      clientRequests: Effect.sync(() => [...pending.values()].filter((p) => p.session !== null).length),
      request: (method, params) =>
        Deferred.await(initialized).pipe(
          Effect.timeoutOption(Duration.seconds(30)),
          Effect.flatMap((o) => (o._tag === "Some" ? ownRequest(method, params) : Effect.fail(`${options.name} is not ready`))),
        ),
    };
    return bridge;
  });
