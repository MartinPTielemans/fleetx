/**
 * An upstream is whatever answers MCP for one hosted server: a remote URL, a
 * container's local port, or a stdio bridge. The gateway sees them all the
 * same way: one HTTP request in, one streamed response out.
 *
 * The proxy upstream adds the server's credential (OAuth or a bearer secret)
 * and handles a 401 itself: one refresh and one retry, then `NeedsLogin`.
 * An upstream's 401 never reaches a client, because a client seeing one would
 * try to sign in to the upstream's authorization server on its own.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { NeedsLogin, type OAuthError } from "./OAuth.ts";

export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", { message: Schema.String }) {}

/** Headers passed from a client to an upstream. Never Authorization: that is the client's token for the hub. */
export const REQUEST_HEADERS: ReadonlyArray<string> = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
/** Headers passed back from an upstream to a client. Never WWW-Authenticate. */
export const RESPONSE_HEADERS: ReadonlyArray<string> = ["content-type", "mcp-session-id", "mcp-protocol-version"];

export interface ForwardRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array, UpstreamError>;
}

export interface Upstream {
  readonly forward: (request: ForwardRequest) => Effect.Effect<UpstreamResponse, UpstreamError | NeedsLogin>;
}

/** A small complete response. */
export const textResponse = (status: number, text: string, headers: Readonly<Record<string, string>> = {}): UpstreamResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: text === "" ? Stream.empty : Stream.make(new TextEncoder().encode(text)),
});

/** The whole body as text, at most `limit` characters. */
export const readBody = (response: UpstreamResponse, limit = 4_000_000) =>
  response.body.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => (acc.length >= limit ? acc : acc + chunk),
    ),
  );

/** How a proxy authenticates to its upstream. */
export interface Credential {
  readonly token: Effect.Effect<string | null, NeedsLogin | OAuthError | UpstreamError>;
  /** The upstream answered 401 to `token`: a token to retry with once, or a failure. */
  readonly rejected: (token: string | null, challenge: string | null) => Effect.Effect<string, NeedsLogin | OAuthError | UpstreamError>;
}

export const noCredential = (server: string): Credential => ({
  token: Effect.succeed(null),
  rejected: () => Effect.fail(new NeedsLogin({ server, message: "the server asks for a sign-in" })),
});

const pick = (headers: Readonly<Record<string, string | undefined>>, names: ReadonlyArray<string>) => {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = headers[name];
    if (typeof v === "string") out[name] = v;
  }
  return out;
};

const toUpstreamResponse = (response: HttpClientResponse.HttpClientResponse): UpstreamResponse => ({
  status: response.status,
  headers: pick(response.headers, RESPONSE_HEADERS),
  body: response.stream.pipe(Stream.mapError((e) => new UpstreamError({ message: `the upstream stream failed: ${e._tag}` }))),
});

const asUpstreamError = (e: OAuthError | UpstreamError) => (e._tag === "OAuthError" ? new UpstreamError({ message: e.message }) : e);

/** Forward to an HTTP MCP endpoint, adding the credential. */
export const makeProxy = (server: string, url: string, credential: Credential) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const send = (request: ForwardRequest, token: string | null) =>
      Effect.gen(function* () {
        let outgoing = HttpClientRequest.make(request.method)(url).pipe(HttpClientRequest.setHeaders(pick(request.headers, REQUEST_HEADERS)));
        if (request.body !== "") outgoing = HttpClientRequest.bodyText(outgoing, request.body, request.headers["content-type"] ?? "application/json");
        if (token !== null) outgoing = HttpClientRequest.bearerToken(outgoing, token);
        return yield* client.execute(outgoing).pipe(
          Effect.timeout(Duration.minutes(10)),
          Effect.mapError((e) => new UpstreamError({ message: e._tag === "TimeoutError" ? `${server} did not answer` : `${server} is unreachable (${e._tag})` })),
        );
      });

    const upstream: Upstream = {
      forward: (request) =>
        Effect.gen(function* () {
          const token = yield* credential.token.pipe(Effect.mapError((e) => (e._tag === "NeedsLogin" ? e : asUpstreamError(e))));
          const first = yield* send(request, token);
          if (first.status !== 401) return toUpstreamResponse(first);
          const challenge = first.headers["www-authenticate"] ?? null;
          const retry = yield* credential.rejected(token, challenge).pipe(Effect.mapError((e) => (e._tag === "NeedsLogin" ? e : asUpstreamError(e))));
          const second = yield* send(request, retry);
          if (second.status !== 401) return toUpstreamResponse(second);
          return yield* new NeedsLogin({ server, message: "the server rejected the login even after a refresh" });
        }),
    };
    return upstream;
  });
