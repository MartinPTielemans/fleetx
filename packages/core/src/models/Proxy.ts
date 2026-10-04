/**
 * The model proxy: `t3-fleet models serve`, on 127.0.0.1:8398 on every node,
 * between T3's providers and the model providers (docs/design/companion.md).
 *
 *   *   /<upstream>/*  → that upstream's url (Recipes.ts): /anthropic/* to
 *                        api.anthropic.com, /openai/* to the OpenAI API or,
 *                        for a ChatGPT login, chatgpt.com/backend-api/codex,
 *                        and any upstream [models.upstreams] declares
 *   GET /stats         ModelProxyStats
 *   GET /health
 *
 * It is a pass-through: the CLI makes every request with its own credential
 * and the proxy forwards it unchanged. What it adds:
 *
 *   retries      network errors before the request left this machine
 *                (refused, unresolvable, a connect timeout), and 408, 429,
 *                500, 502, 503, 504, 529, up to 3 times with jittered backoff,
 *                only while the client has received nothing. It obeys
 *                x-should-retry, honours retry-after-ms and retry-after, and
 *                waits 10s at most in all; past that the answer goes to the
 *                CLI, which retries on its own. A reset or a timeout once the
 *                request was sent is never retried: a POST must not go twice
 *   keepalives   an SSE comment when an event stream has been quiet for 15s,
 *                only between events
 *   stats        rolling windows per upstream, and a metadata-only log
 *
 * Once the response has started, an error reaches the client as an error:
 * the proxy drops the connection instead of ending the body cleanly, so no
 * client takes a cut-off answer for a complete one.
 *
 * With egress = "relay" it sends everything to the relay's /egress route
 * instead, which forwards once; retries still happen here. When the relay
 * cannot be reached, or will not forward, that request goes direct: losing
 * the relay costs speed, never correctness.
 *
 * It counts the requests it is answering (InFlight), so a restart can wait
 * for them: see serveUntilIdle, and untilNewBuild in the CLI.
 *
 * It answers only requests addressed to it by its loopback name
 * (Host 127.0.0.1:<port> or localhost:<port>), so a web page cannot reach it
 * through DNS rebinding, and refuses any request a browser marks as coming
 * from another origin (mirroring UiServer's refusal).
 *
 * Codex prefers a WebSocket for /responses. The proxy answers the upgrade
 * with 426, which makes Codex use HTTP and server-sent events for the session.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Undici from "@effect/platform-node/Undici";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ModelProxyStats, type ModelFailureClass } from "../Api.ts";
import {
  EGRESS_BASE_HEADER,
  EGRESS_FAILURE_HEADER,
  endsAtEventBoundary,
  errorCode,
  failureClassOf,
  isTimeoutCode,
  KEEPALIVE,
  logPath,
  neverSent,
  RELAY_TOKEN_HEADER,
  requestHeaders,
  responseHeaders,
  retryAfterOf,
  retryDelay,
  splitPath,
  targetUrl,
} from "./Forward.ts";
import {
  BUILTIN_UPSTREAMS,
  MODELS_PORT,
  upstreamsOf,
  type ModelsSettings,
  type Upstreams,
} from "./Recipes.ts";
import {
  appendRecord,
  loadFallbacks,
  loadRecords,
  MAX_RECORDS,
  proxyStats,
  WINDOWS,
  type RequestRecord,
} from "./Stats.ts";

export { MODELS_PORT };

export interface ModelProxyOptions {
  readonly home: string;
  /** T3 Fleet's version, reported in /stats. */
  readonly version: string;
  readonly egress: "direct" | "relay";
  /** Where egress = "relay" sends requests, and the token it needs. */
  readonly relay?: { readonly url: string; readonly token: string };
  /** Read on every request, so the CLI can reload [models.upstreams] without a restart. */
  readonly upstreams?: () => Upstreams;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly keepaliveEvery?: Duration.Input;
  /** How long to wait for an upstream's response headers (default 10 minutes). */
  readonly headersTimeout?: Duration.Input;
  /** How long an upstream's body may go quiet before the proxy gives up on it (default 10 minutes). */
  readonly bodyTimeout?: Duration.Input;
  /** Counts the requests being answered, for a restart to wait on. */
  readonly inFlight?: InFlight;
  /** Append to models.jsonl and restore the last day from it (default true). */
  readonly persist?: boolean;
}

const encodeStats = Schema.encodeEffect(Schema.fromJsonString(ModelProxyStats));
const KEEPALIVE_BYTES = new TextEncoder().encode(KEEPALIVE);

// ---- requests in flight ----------------------------------------------------

/** The requests the proxy is answering right now, from the request's arrival until its response is done. */
export interface InFlight {
  readonly count: () => number;
  /** Counts one request; the function it returns stops counting it, once however often it is called. */
  readonly enter: () => () => void;
}

export const makeInFlight = (): InFlight => {
  let count = 0;
  return {
    count: () => count,
    enter: () => {
      count++;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        count--;
      };
    },
  };
};

/** Waits until no request is in flight, for at most `within`; true when it got there. */
export const whenIdle = (
  inFlight: InFlight,
  within: Duration.Input,
  every: Duration.Input = Duration.millis(250),
) =>
  Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.fromInputUnsafe(within));
    while (inFlight.count() > 0) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return false;
      yield* Effect.sleep(every);
    }
    return true;
  });

/**
 * Serves until interrupted. Interruption (SIGTERM, through the CLI's runtime)
 * closes the scope, and the wait for requests in flight was added after the
 * server, so it runs first: the listener keeps answering until the last
 * response is done, for at most `within`, and only then does the server stop.
 */
export const serveUntilIdle = <E, R>(
  served: Layer.Layer<never, E, R>,
  inFlight: InFlight,
  within: Duration.Input,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Layer.build(served);
      yield* Effect.addFinalizer(() => whenIdle(inFlight, within));
      return yield* Effect.never;
    }),
  );

// ---- the upstream client ---------------------------------------------------

/** How long to wait for a connection to an upstream, and to the relay, which is either up or should be skipped quickly. */
export const CONNECT_TIMEOUT_MS = 30_000;
export const RELAY_CONNECT_TIMEOUT_MS = 5_000;

/** The connect timeout for an origin: short for the ones in `quick` (the relay). */
export const connectTimeoutFor = (origin: string | URL, quick: ReadonlyArray<string>) => {
  const of = (url: string | URL) => URL.parse(String(url))?.origin ?? String(url);
  return quick.some((q) => of(q) === of(origin)) ? RELAY_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
};

/**
 * The HTTP client the proxy and the relay's egress route forward with: an
 * undici agent whose header and body timeouts are the proxy's own, where
 * Node's fetch would give up waiting for headers after 300s and on a body
 * quiet for 300s, whatever the proxy says. Connections to the `quick`
 * origins (the relay) give up after 5s, so a relay host that is offline
 * sends requests direct without a long wait.
 */
export const forwardingClient = (timeouts: {
  readonly headersTimeout: Duration.Input;
  readonly bodyTimeout: Duration.Input;
  readonly quick?: ReadonlyArray<string>;
}) => {
  const headersTimeout = Duration.toMillis(Duration.fromInputUnsafe(timeouts.headersTimeout));
  const bodyTimeout = Duration.toMillis(Duration.fromInputUnsafe(timeouts.bodyTimeout));
  const quick = timeouts.quick ?? [];
  return NodeHttpClient.layerUndiciNoDispatcher.pipe(
    Layer.provide(
      Layer.effect(NodeHttpClient.Dispatcher)(
        Effect.acquireRelease(
          // Effect's undici client sets its own timeouts on every request; these replace them.
          Effect.sync(() =>
            new Undici.Agent({
              factory: (origin, opts) =>
                new Undici.Pool(origin, {
                  ...opts,
                  connectTimeout: connectTimeoutFor(origin, quick),
                }),
            }).compose(
              (dispatch) => (opts, handler) =>
                dispatch({ ...opts, headersTimeout, bodyTimeout }, handler),
            ),
          ),
          (dispatcher) => Effect.promise(() => dispatcher.destroy()),
        ),
      ),
    ),
  );
};

/** Every model request forwards one to one: no tracing headers added, nothing else. */
export const sendUpstream = (input: {
  readonly method: HttpServerRequest.HttpServerRequest["method"];
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(input.method)(input.url).pipe(
      HttpClientRequest.setHeaders(input.headers),
    );
    if (input.body !== null) {
      request = HttpClientRequest.bodyUint8Array(
        request,
        input.body,
        input.headers["content-type"] ?? "application/octet-stream",
      );
    }
    return yield* client.execute(request);
  }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

/** A network error in words, without the URL (whose query could carry anything). */
export const describeTransport = (error: unknown): string =>
  errorCode(error) ?? "connection failed";

/** The client's connection under a request; undefined off Node (tests with another server). */
export const clientConnection = (
  request: HttpServerRequest.HttpServerRequest,
): ReturnType<typeof NodeHttpServerRequest.toServerResponse> | undefined => {
  const response: unknown = NodeHttpServerRequest.toServerResponse(request);
  return typeof response === "object" && response !== null && "destroy" in response
    ? (response as ReturnType<typeof NodeHttpServerRequest.toServerResponse>)
    : undefined;
};

/** Injects a keepalive comment into an event stream quiet for one interval, only between events. */
export const withKeepalive = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  every: Duration.Input,
): Stream.Stream<Uint8Array, E> =>
  Stream.merge(
    stream.pipe(Stream.map((bytes): Uint8Array | null => bytes)),
    Stream.tick(every).pipe(Stream.map((): Uint8Array | null => null)),
    { haltStrategy: "left" },
  ).pipe(
    Stream.mapAccum(
      () => ({ quiet: false, tail: "" }),
      (state, item): readonly [{ quiet: boolean; tail: string }, ReadonlyArray<Uint8Array>] => {
        if (item === null) {
          const send = state.quiet && endsAtEventBoundary(state.tail);
          return [{ quiet: true, tail: send ? "\n\n" : state.tail }, send ? [KEEPALIVE_BYTES] : []];
        }
        if (item.length === 0) return [state, []];
        const tail = (state.tail + String.fromCharCode(...item.subarray(-4))).slice(-4);
        return [{ quiet: false, tail }, [item]];
      },
    ),
  );

/**
 * Why a request is refused before anything else happens, or null: only the
 * proxy's own loopback names, with this port, are answered (421 otherwise),
 * and a browser's cross-origin request is refused (403). The CLIs send no
 * Origin.
 */
export const proxyRefusal = (
  headers: Readonly<Record<string, string | undefined>>,
  port: number,
): { readonly status: number; readonly message: string } | null => {
  const allowed = ["127.0.0.1", "localhost"].map((h) => `${h}:${port}`);
  const host = headers["host"];
  if (host === undefined || !allowed.includes(host))
    return {
      status: 421,
      message: "the T3 Fleet model proxy answers only on its loopback address",
    };
  const origin = headers["origin"];
  if (origin !== undefined && !allowed.some((h) => origin === `http://${h}`))
    return { status: 403, message: "cross-origin requests are refused" };
  return null;
};

/**
 * [models.upstreams] as `load` reads it, read again every `every`. A read
 * that fails (a config mid-sync, a broken table) keeps the last good set.
 */
export const followUpstreams = <E, R>(
  load: Effect.Effect<ModelsSettings, E, R>,
  initial: ModelsSettings,
  every: Duration.Input,
) =>
  Effect.gen(function* () {
    let current = upstreamsOf(initial);
    yield* load.pipe(
      Effect.map((settings) => {
        current = upstreamsOf(settings);
      }),
      Effect.ignore,
      Effect.repeat(Schedule.spaced(every)),
      Effect.forkScoped,
    );
    return (): Upstreams => current;
  });

/** A network error on the way to an upstream: its code, and whether it happened at the relay. */
interface SendFailure {
  readonly code: string | null;
  readonly timedOut: boolean;
  /** Reported by the relay's /egress route rather than met on the way to it. */
  readonly behindRelay: boolean;
}

/** The proxy's routes, as one layer; needs the HttpServer it runs on (for its port). */
export const modelProxyLayer = (options: ModelProxyOptions) => {
  const headersTimeout = options.headersTimeout ?? Duration.minutes(10);
  const bodyTimeout = options.bodyTimeout ?? Duration.minutes(10);
  return Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const address = (yield* HttpServer.HttpServer).address;
      const port = "port" in address ? address.port : MODELS_PORT;
      const guarded = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const refused = proxyRefusal(request.headers, port);
          return refused === null
            ? yield* handler
            : HttpServerResponse.text(refused.message, { status: refused.status });
        });
      const persist = options.persist ?? true;
      const upstreams = options.upstreams ?? (() => BUILTIN_UPSTREAMS);
      const keepaliveEvery = options.keepaliveEvery ?? Duration.seconds(15);
      // Plain array, appended by one request at a time; windows filter it on /stats.
      const records: Array<RequestRecord> = persist
        ? yield* loadRecords(options.home, startedAt)
        : [];
      // Records are written from response streams, which must need nothing from outside.
      const services = yield* Effect.context<FileSystem.FileSystem>();
      const client = yield* HttpClient.HttpClient;

      const remember = (record: RequestRecord) =>
        Effect.gen(function* () {
          records.push(record);
          const cutoff = record.at - WINDOWS.h24;
          let drop = Math.max(0, records.length - MAX_RECORDS);
          while (drop < records.length && (records[drop]?.at ?? 0) < cutoff) drop++;
          if (drop > 0) records.splice(0, drop);
          if (persist) yield* appendRecord(options.home, record);
        }).pipe(Effect.provide(services));

      const health = HttpRouter.add(
        "GET",
        "/health",
        guarded(Effect.succeed(HttpServerResponse.text("ok"))),
      );

      const stats = HttpRouter.add(
        "GET",
        "/stats",
        guarded(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const fallbacks = yield* loadFallbacks(options.home, now);
            const body = yield* encodeStats(
              proxyStats({
                names: Object.keys(upstreams()),
                now,
                startedAt,
                version: options.version,
                egress: options.egress,
                records,
                fallbacks,
              }),
            );
            return HttpServerResponse.text(body, { contentType: "application/json" });
          }).pipe(
            Effect.orElseSucceed(() =>
              HttpServerResponse.text("Internal Server Error", { status: 500 }),
            ),
          ),
        ),
      );

      const forward = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const started = yield* Clock.currentTimeMillis;
        const split = splitPath(request.url);
        if (split === null) return HttpServerResponse.text("Not Found", { status: 404 });
        if ((request.headers["upgrade"] ?? "").toLowerCase() === "websocket") {
          return HttpServerResponse.text("The T3 Fleet model proxy speaks HTTP only", {
            status: 426,
          });
        }
        const { upstream, rest } = split;
        const direct = targetUrl(upstreams(), upstream, rest, request.headers);
        if (direct === null)
          return HttpServerResponse.text(`No upstream named ${upstream} in [models.upstreams]`, {
            status: 404,
          });

        // Counted until the client's connection is done with this response, however that happens.
        const connection = clientConnection(request);
        if (options.inFlight !== undefined && connection !== undefined) {
          const leave = options.inFlight.enter();
          connection.once("close", leave);
          if (connection.destroyed) leave();
        }

        const headers = requestHeaders(request.headers);
        const relay = options.egress === "relay" ? options.relay : undefined;
        // The relay forwards to the base this node resolved; the rest of the path follows.
        const relayed =
          relay === undefined
            ? null
            : {
                url: `${relay.url.replace(/\/+$/, "")}/egress/${upstream}${rest}`,
                headers: {
                  ...headers,
                  [RELAY_TOKEN_HEADER]: relay.token,
                  [EGRESS_BASE_HEADER]: direct.slice(0, direct.length - rest.length),
                },
              };
        let target = relayed ?? { url: direct, headers };
        const body =
          request.method === "GET" || request.method === "HEAD"
            ? null
            : new Uint8Array(yield* request.arrayBuffer);
        const host = new URL(direct).host;

        const record = (fields: {
          status: number | null;
          attempts: number;
          ttfbMs: number | null;
          failure: ModelFailureClass | null;
          error: string | null;
        }) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              remember({
                at: now,
                upstream,
                method: request.method,
                path: logPath(rest),
                durationMs: now - started,
                ...fields,
              }),
            ),
          );

        let attempt = 0;
        let waited = 0;
        while (true) {
          const result = yield* sendUpstream({
            method: request.method,
            url: target.url,
            headers: target.headers,
            body,
          }).pipe(Effect.timeoutOption(headersTimeout), Effect.result);
          const now = yield* Clock.currentTimeMillis;
          let failure: SendFailure | null = null;
          let response: HttpClientResponse.HttpClientResponse | null = null;
          if (result._tag === "Failure")
            failure = { code: errorCode(result.failure), timedOut: false, behindRelay: false };
          else if (Option.isNone(result.success))
            failure = { code: null, timedOut: true, behindRelay: false };
          else {
            response = result.success.value;
            const reported =
              target === relayed ? response.headers[EGRESS_FAILURE_HEADER] : undefined;
            if (reported !== undefined) {
              yield* response.arrayBuffer.pipe(Effect.ignore);
              failure = { code: reported, timedOut: false, behindRelay: true };
            }
          }

          if (failure !== null || response === null) {
            const { code, behindRelay } = failure ?? { code: null, behindRelay: false };
            // The relay cannot be reached, or will not forward: this request goes direct, at once.
            if (target === relayed && ((!behindRelay && neverSent(code)) || code === "refused")) {
              target = { url: direct, headers };
              continue;
            }
            const timedOut = failure?.timedOut === true || isTimeoutCode(code);
            const message = timedOut
              ? `no response from ${host} within ${Duration.format(Duration.fromInputUnsafe(headersTimeout))}`
              : `${code ?? "connection failed"} (${host}${behindRelay ? ", at the relay" : ""})`;
            const delay = neverSent(code)
              ? retryDelay({
                  attempt,
                  status: null,
                  retryAfter: null,
                  waited,
                  random: yield* Random.next,
                  maxRetries: options.maxRetries,
                  baseMs: options.retryBaseMs,
                })
              : null;
            if (delay !== null) {
              attempt++;
              waited += delay;
              yield* Effect.sleep(Duration.millis(delay));
              continue;
            }
            yield* record({
              status: null,
              attempts: attempt + 1,
              ttfbMs: null,
              failure: timedOut ? "timeout" : "connect",
              error: message,
            });
            return HttpServerResponse.text(`T3 Fleet model proxy: ${message}`, {
              status: timedOut ? 504 : 502,
            });
          }

          const delay = retryDelay({
            attempt,
            status: response.status,
            retryAfter: retryAfterOf(response.headers, now),
            shouldRetry: response.headers["x-should-retry"],
            waited,
            random: yield* Random.next,
            maxRetries: options.maxRetries,
            baseMs: options.retryBaseMs,
          });
          if (delay !== null) {
            // Nothing has reached the client: drop this answer and ask again.
            yield* response.arrayBuffer.pipe(Effect.ignore);
            attempt++;
            waited += delay;
            yield* Effect.sleep(Duration.millis(delay));
            continue;
          }
          const ttfbMs = now - started;
          const status = response.status;
          const statusFailure = failureClassOf(status);
          const finished = {
            status,
            attempts: attempt + 1,
            ttfbMs,
            failure: statusFailure,
            error: statusFailure === null ? null : `HTTP ${status} from ${host}`,
          };
          const contentType = response.headers["content-type"];
          const outHeaders = responseHeaders(response.headers);

          // A HEAD response has no body, and the server never runs one: the record is written here.
          if (request.method === "HEAD") {
            yield* response.arrayBuffer.pipe(Effect.ignore);
            yield* record(finished);
            return HttpServerResponse.empty({
              status,
              headers:
                contentType === undefined
                  ? outHeaders
                  : { ...outHeaders, "content-type": contentType },
            });
          }

          const encoded = (response.headers["content-encoding"] ?? "identity") !== "identity";
          const bytes =
            (contentType ?? "").includes("text/event-stream") && !encoded
              ? withKeepalive(response.stream, keepaliveEvery)
              : response.stream;
          const streamed = bytes.pipe(
            // The client's error names the request, query and all; the log and the client get no more than this.
            Stream.mapError(() => `the response from ${host} broke off after it started`),
            Stream.onExit((exit) => {
              if (Exit.isSuccess(exit)) return record(finished);
              const interrupted = Cause.hasInterruptsOnly(exit.cause);
              const clientGone =
                connection === undefined ||
                connection.destroyed ||
                connection.socket === null ||
                connection.socket.destroyed;
              // A client that hangs up is not an upstream failure.
              if (interrupted && clientGone) return record(finished);
              // Broken off upstream, or cut by the proxy stopping: drop the connection, so the
              // client sees an error instead of a body that ends cleanly.
              connection?.destroy();
              return record({
                ...finished,
                failure: "stream",
                error: interrupted
                  ? `the proxy stopped before the response from ${host} finished`
                  : `the response from ${host} broke off after it started`,
              });
            }),
          );
          return HttpServerResponse.stream(streamed, {
            status,
            headers: outHeaders,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      return Layer.mergeAll(health, stats, HttpRouter.add("*", "/*", guarded(forward)));
    }),
  ).pipe(
    Layer.provide(
      forwardingClient({
        headersTimeout,
        bodyTimeout,
        ...(options.relay === undefined ? {} : { quick: [options.relay.url] }),
      }),
    ),
  );
};

/** This node's proxy stats, or null when nothing answers on the port. */
export const fetchStats = (port: number = MODELS_PORT) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(`http://127.0.0.1:${port}/stats`))
      .pipe(Effect.timeout(Duration.seconds(3)));
    if (response.status !== 200) return null;
    return yield* Schema.decodeEffect(Schema.fromJsonString(ModelProxyStats))(yield* response.text);
  }).pipe(Effect.orElseSucceed(() => null));
