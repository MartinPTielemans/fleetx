/**
 * The model proxy: `fleetx models serve`, on 127.0.0.1:8398 on every node,
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
 *   retries      connection errors and 408, 429, 500, 502, 503, 504, 529,
 *                up to 3 times with jittered backoff, honouring retry-after
 *                up to 30s, and only while the client has received nothing;
 *                once the response has started, an error passes through
 *   keepalives   an SSE comment when an event stream has been quiet for 15s,
 *                only between events
 *   stats        rolling windows per upstream, and a metadata-only log
 *
 * With egress = "relay" it sends everything to the relay's /egress route
 * instead, which forwards once; retries still happen here.
 *
 * Codex prefers a WebSocket for /responses. The proxy answers the upgrade
 * with 426, which makes Codex use HTTP and server-sent events for the session.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { ModelProxyStats, type ModelFailureClass } from "../Api.ts";
import {
  endsAtEventBoundary,
  failureClassOf,
  KEEPALIVE,
  logPath,
  RELAY_TOKEN_HEADER,
  requestHeaders,
  responseHeaders,
  retryAfterMs,
  retryDelay,
  EGRESS_BASE_HEADER,
  splitPath,
  targetUrl,
} from "./Forward.ts";
import { BUILTIN_UPSTREAMS, MODELS_PORT, type Upstreams } from "./Recipes.ts";
import { appendRecord, loadFallbacks, loadRecords, MAX_RECORDS, proxyStats, WINDOWS, type RequestRecord } from "./Stats.ts";

export { MODELS_PORT };

export interface ModelProxyOptions {
  readonly home: string;
  /** fleetx's version, reported in /stats. */
  readonly version: string;
  readonly egress: "direct" | "relay";
  /** Where egress = "relay" sends requests, and the token it needs. */
  readonly relay?: { readonly url: string; readonly token: string };
  /** Read on every request, so the CLI can reload [models.upstreams] without a restart. */
  readonly upstreams?: () => Upstreams;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly keepaliveEvery?: Duration.Input;
  /** How long to wait for an upstream's response headers. */
  readonly headersTimeout?: Duration.Input;
  /** Append to models.jsonl and restore the last day from it (default true). */
  readonly persist?: boolean;
}

const encodeStats = Schema.encodeEffect(Schema.fromJsonString(ModelProxyStats));
const KEEPALIVE_BYTES = new TextEncoder().encode(KEEPALIVE);

/** Every model request forwards one to one: no tracing headers added, nothing else. */
export const sendUpstream = (input: {
  readonly method: HttpServerRequest.HttpServerRequest["method"];
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(input.method)(input.url).pipe(HttpClientRequest.setHeaders(input.headers));
    if (input.body !== null) {
      request = HttpClientRequest.bodyUint8Array(request, input.body, input.headers["content-type"] ?? "application/octet-stream");
    }
    return yield* client.execute(request);
  }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

/** A network error in words, without the URL (whose query could carry anything). */
export const describeTransport = (error: unknown): string => {
  const cause = (error as { reason?: { cause?: unknown } }).reason?.cause;
  const inner = (cause as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const code = inner?.code ?? inner?.message ?? (cause as { message?: unknown } | undefined)?.message;
  return typeof code === "string" && code !== "" ? code : "connection failed";
};

/** Injects a keepalive comment into an event stream quiet for one interval, only between events. */
export const withKeepalive = <E>(stream: Stream.Stream<Uint8Array, E>, every: Duration.Input): Stream.Stream<Uint8Array, E> =>
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

/** The proxy's routes, as one layer; needs an HttpClient. */
export const modelProxyLayer = (options: ModelProxyOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const persist = options.persist ?? true;
      const upstreams = options.upstreams ?? (() => BUILTIN_UPSTREAMS);
      const keepaliveEvery = options.keepaliveEvery ?? Duration.seconds(15);
      const headersTimeout = options.headersTimeout ?? Duration.minutes(10);
      // Plain array, appended by one request at a time; windows filter it on /stats.
      const records: Array<RequestRecord> = persist ? yield* loadRecords(options.home, startedAt) : [];
      // Records are written from response streams, which must need nothing from outside.
      const services = yield* Effect.context<FileSystem.FileSystem>();

      const remember = (record: RequestRecord) =>
        Effect.gen(function* () {
          records.push(record);
          const cutoff = record.at - WINDOWS.h24;
          let drop = Math.max(0, records.length - MAX_RECORDS);
          while (drop < records.length && (records[drop]?.at ?? 0) < cutoff) drop++;
          if (drop > 0) records.splice(0, drop);
          if (persist) yield* appendRecord(options.home, record);
        }).pipe(Effect.provide(services));

      const health = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"));

      const stats = HttpRouter.add(
        "GET",
        "/stats",
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const fallbacks = yield* loadFallbacks(options.home, now);
          const body = yield* encodeStats(proxyStats({ names: Object.keys(upstreams()), now, startedAt, version: options.version, egress: options.egress, records, fallbacks }));
          return HttpServerResponse.text(body, { contentType: "application/json" });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 }))),
      );

      const forward = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const started = yield* Clock.currentTimeMillis;
        const split = splitPath(request.url);
        if (split === null) return HttpServerResponse.text("Not Found", { status: 404 });
        if ((request.headers["upgrade"] ?? "").toLowerCase() === "websocket") {
          return HttpServerResponse.text("The fleetx model proxy speaks HTTP only", { status: 426 });
        }
        const { upstream, rest } = split;
        const direct = targetUrl(upstreams(), upstream, rest, request.headers);
        if (direct === null) return HttpServerResponse.text(`No upstream named ${upstream} in [models.upstreams]`, { status: 404 });
        const headers = requestHeaders(request.headers);
        let url = direct;
        if (options.egress === "relay" && options.relay !== undefined) {
          // The relay forwards to the base this node resolved; the rest of the path follows.
          url = `${options.relay.url.replace(/\/+$/, "")}/egress/${upstream}${rest}`;
          headers[RELAY_TOKEN_HEADER] = options.relay.token;
          headers[EGRESS_BASE_HEADER] = direct.slice(0, direct.length - rest.length);
        }
        const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(yield* request.arrayBuffer);
        const host = new URL(url).host;

        const record = (fields: { status: number | null; attempts: number; ttfbMs: number | null; failure: ModelFailureClass | null; error: string | null }) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              remember({ at: now, upstream, method: request.method, path: logPath(rest), durationMs: now - started, ...fields }),
            ),
          );

        let attempt = 0;
        while (true) {
          const result = yield* sendUpstream({ method: request.method, url, headers, body }).pipe(Effect.timeoutOption(headersTimeout), Effect.result);
          const now = yield* Clock.currentTimeMillis;
          if (result._tag === "Failure" || Option.isNone(result.success)) {
            const timedOut = result._tag === "Success";
            const message = timedOut ? `no response from ${host} within ${Duration.format(Duration.fromInputUnsafe(headersTimeout))}` : `${describeTransport(result.failure)} (${host})`;
            const delay = timedOut ? null : retryDelay({ attempt, status: null, retryAfter: null, random: yield* Random.next, maxRetries: options.maxRetries, baseMs: options.retryBaseMs });
            if (delay !== null) {
              attempt++;
              yield* Effect.sleep(Duration.millis(delay));
              continue;
            }
            yield* record({ status: null, attempts: attempt + 1, ttfbMs: null, failure: timedOut ? "timeout" : "connect", error: message });
            return HttpServerResponse.text(`fleetx model proxy: ${message}`, { status: timedOut ? 504 : 502 });
          }
          const response = result.success.value;
          const delay = retryDelay({
            attempt,
            status: response.status,
            retryAfter: retryAfterMs(response.headers["retry-after"], now),
            random: yield* Random.next,
            maxRetries: options.maxRetries,
            baseMs: options.retryBaseMs,
          });
          if (delay !== null) {
            // Nothing has reached the client: drop this answer and ask again.
            yield* response.arrayBuffer.pipe(Effect.ignore);
            attempt++;
            yield* Effect.sleep(Duration.millis(delay));
            continue;
          }
          const ttfbMs = now - started;
          const statusFailure = failureClassOf(response.status);
          const contentType = response.headers["content-type"];
          const bytes = (contentType ?? "").includes("text/event-stream") ? withKeepalive(response.stream, keepaliveEvery) : response.stream;
          const streamed = bytes.pipe(
            Stream.onExit((exit) => {
              const base = { status: response.status, attempts: attempt + 1, ttfbMs };
              if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
                // A client that hangs up is not an upstream failure.
                return record({ ...base, failure: statusFailure, error: statusFailure === null ? null : `HTTP ${response.status} from ${host}` });
              }
              return record({ ...base, failure: "stream", error: `the response from ${host} broke off after it started` });
            }),
          );
          return HttpServerResponse.stream(streamed, {
            status: response.status,
            headers: responseHeaders(response.headers),
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      });

      return Layer.mergeAll(health, stats, HttpRouter.add("*", "/*", forward));
    }),
  );

/** This node's proxy stats, or null when nothing answers on the port. */
export const fetchStats = (port: number = MODELS_PORT) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/stats`)).pipe(Effect.timeout(Duration.seconds(3)));
    if (response.status !== 200) return null;
    return yield* Schema.decodeEffect(Schema.fromJsonString(ModelProxyStats))(yield* response.text);
  }).pipe(Effect.orElseSucceed(() => null));

