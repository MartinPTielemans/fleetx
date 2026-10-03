/**
 * The relay's egress route, for nodes whose [models] egress = "relay": a node
 * on a bad network sends its model traffic to the relay, which forwards it
 * from a better one.
 *
 *   *   /egress/anthropic/*   → https://api.anthropic.com/*
 *   *   /egress/openai/*      → the OpenAI upstream for the request's login
 *
 * It forwards once and streams the answer back; the node's own proxy does
 * the retrying and keeps the stats. The relay token comes in its own header
 * (x-fleetx-relay-token), because Authorization carries the client's own
 * credential, which passes through unchanged like everything else.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { RELAY_TOKEN_HEADER, requestHeaders, responseHeaders, splitPath, targetUrl, UPSTREAMS, type Upstreams } from "./Forward.ts";
import { sendUpstream } from "./Proxy.ts";

export const egressLayer = (token: string, upstreams: Upstreams = UPSTREAMS) => {
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (token === "" || request.headers[RELAY_TOKEN_HEADER] !== token) return HttpServerResponse.text("Unauthorized", { status: 401 });
    const split = splitPath(request.url, "/egress");
    if (split === null) return HttpServerResponse.text("Not Found", { status: 404 });
    const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(yield* request.arrayBuffer);
    const response = yield* sendUpstream({
      method: request.method,
      url: targetUrl(split.upstream, split.rest, request.headers, upstreams),
      headers: requestHeaders(request.headers),
      body,
    });
    const contentType = response.headers["content-type"];
    return HttpServerResponse.stream(response.stream, {
      status: response.status,
      headers: responseHeaders(response.headers),
      ...(contentType === undefined ? {} : { contentType }),
    });
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Bad Gateway", { status: 502 })));
  return Layer.mergeAll(HttpRouter.add("*", "/egress/anthropic/*", handler), HttpRouter.add("*", "/egress/openai/*", handler));
};
