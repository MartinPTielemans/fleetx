/**
 * The relay's egress route, for nodes whose [models] egress = "relay": a node
 * on a bad network sends its model traffic to the relay, which forwards it
 * from a better one.
 *
 *   *   /egress/<upstream>/*   → the upstream base the node resolved
 *
 * The node resolves the upstream itself, from its own [models.upstreams],
 * and sends the base in x-fleetx-egress-base; the relay only forwards to
 * https. It forwards once and streams the answer back; the node's own proxy
 * does the retrying and keeps the stats. The relay token comes in its own
 * header (x-fleetx-relay-token), because Authorization carries the client's
 * own credential, which passes through unchanged like everything else.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { EGRESS_BASE_HEADER, RELAY_TOKEN_HEADER, requestHeaders, responseHeaders, splitPath } from "./Forward.ts";
import { sendUpstream } from "./Proxy.ts";

/** `allowInsecure` lets tests use a plain-HTTP fake upstream. */
export const egressLayer = (token: string, options: { readonly allowInsecure?: boolean } = {}) =>
  HttpRouter.add(
    "*",
    "/egress/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (token === "" || request.headers[RELAY_TOKEN_HEADER] !== token) return HttpServerResponse.text("Unauthorized", { status: 401 });
      const split = splitPath(request.url, "/egress");
      const base = request.headers[EGRESS_BASE_HEADER] ?? "";
      if (split === null || !(base.startsWith("https://") || (options.allowInsecure === true && base.startsWith("http://")))) {
        return HttpServerResponse.text("Bad Request", { status: 400 });
      }
      const body = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(yield* request.arrayBuffer);
      const response = yield* sendUpstream({ method: request.method, url: `${base}${split.rest}`, headers: requestHeaders(request.headers), body });
      const contentType = response.headers["content-type"];
      return HttpServerResponse.stream(response.stream, {
        status: response.status,
        headers: responseHeaders(response.headers),
        ...(contentType === undefined ? {} : { contentType }),
      });
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Bad Gateway", { status: 502 }))),
  );
