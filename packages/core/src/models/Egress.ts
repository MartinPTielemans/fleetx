/**
 * The relay's egress route, for nodes whose [models] egress = "relay": a node
 * on a bad network sends its model traffic to the relay, which forwards it
 * from a better one.
 *
 *   *   /egress/<upstream>/*   → the upstream base the node resolved
 *
 * The node resolves the upstream itself, from its own [models.upstreams],
 * and sends the base in x-t3-fleet-egress-base; the relay forwards only to
 * an https base that some node's [models] declares (the built-in anthropic
 * and openai bases, and whatever `upstreams` returns), never anywhere else on
 * the tailnet. It forwards once and streams the answer back; the node's own
 * proxy does the retrying and keeps the stats. The relay token comes in its
 * own header (x-t3-fleet-relay-token), because Authorization carries the
 * client's own credential, which passes through unchanged like everything
 * else.
 *
 * When the relay gets no answer from the upstream, or will not forward, it
 * says so in x-t3-fleet-egress-failure, so the node treats it as its own
 * network error (and may send the request direct) instead of passing a 502
 * or a 401 to the CLI as if the upstream had said it. A response that breaks
 * off drops the node's connection, as the proxy does with its client.
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  EGRESS_FAILURE_HEADER,
  errorCode,
  requestHeaders,
  responseHeaders,
  splitPath,
} from "./Forward.ts";
import { constantTimeEqual, hashToken } from "../hub/Policy.ts";
import { clientConnection, forwardingClient, sendUpstream } from "./Proxy.ts";
import { BUILTIN_UPSTREAMS, upstreamBases } from "./Recipes.ts";
import { readHeader } from "../Names.ts";

export interface EgressOptions {
  /** Every base the relay may forward to; read on each request. Defaults to the built-in upstreams. */
  readonly bases?: () => ReadonlyArray<string>;
  /** Lets tests use a plain-HTTP fake upstream. */
  readonly allowInsecure?: boolean;
}

const refused = (status: number, message: string) =>
  HttpServerResponse.text(message, { status, headers: { [EGRESS_FAILURE_HEADER]: "refused" } });

export const egressLayer = (token: string, options: EgressOptions = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Captured here so the route needs nothing from the server that runs it.
      const client = yield* HttpClient.HttpClient;
      const bases = options.bases ?? (() => upstreamBases(BUILTIN_UPSTREAMS));
      return HttpRouter.add(
        "*",
        "/egress/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const given = readHeader(request.headers, "relay-token") ?? "";
          if (token === "" || !constantTimeEqual(yield* hashToken(given), yield* hashToken(token)))
            return refused(401, "Unauthorized");
          const split = splitPath(request.url, "/egress");
          const base = readHeader(request.headers, "egress-base") ?? "";
          const scheme =
            base.startsWith("https://") ||
            (options.allowInsecure === true && base.startsWith("http://"));
          if (split === null || !scheme || !bases().includes(base))
            return refused(400, "the relay does not forward to that upstream");
          const body =
            request.method === "GET" || request.method === "HEAD"
              ? null
              : new Uint8Array(yield* request.arrayBuffer);
          const sent = yield* sendUpstream({
            method: request.method,
            url: `${base}${split.rest}`,
            headers: requestHeaders(request.headers),
            body,
          }).pipe(Effect.result);
          if (sent._tag === "Failure") {
            const code = errorCode(sent.failure) ?? "connection failed";
            return HttpServerResponse.text("Bad Gateway", {
              status: 502,
              headers: { [EGRESS_FAILURE_HEADER]: code },
            });
          }
          const response = sent.success;
          const contentType = response.headers["content-type"];
          const connection = clientConnection(request);
          const streamed = response.stream.pipe(
            Stream.mapError(() => "the upstream's response broke off"),
            Stream.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
                  connection?.destroy();
              }),
            ),
          );
          return HttpServerResponse.stream(streamed, {
            status: response.status,
            headers: responseHeaders(response.headers),
            ...(contentType === undefined ? {} : { contentType }),
          });
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.orElseSucceed(() => HttpServerResponse.text("Bad Gateway", { status: 502 })),
        ),
      );
    }),
  ).pipe(
    Layer.provide(
      forwardingClient({ headersTimeout: Duration.minutes(10), bodyTimeout: Duration.minutes(10) }),
    ),
  );
