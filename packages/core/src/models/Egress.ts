/**
 * The relay's egress route, for nodes whose [models] egress = "relay": a node
 * on a bad network sends its model traffic to the relay, which forwards it
 * from a better one.
 *
 *   *   /egress/<upstream>/*   → the upstream base the node resolved
 *
 * The node resolves the upstream itself, from its own [models.upstreams],
 * and sends the base in x-t3-fleet-egress-base; the relay only forwards to
 * https. It forwards once and streams the answer back; the node's own proxy
 * does the retrying and keeps the stats. The relay token comes in its own
 * header (x-t3-fleet-relay-token), because Authorization carries the client's
 * own credential, which passes through unchanged like everything else.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  requestHeaders,
  responseHeaders,
  splitPath,
} from "./Forward.ts";
import { constantTimeEqual, hashToken } from "../hub/Policy.ts";
import { sendUpstream } from "./Proxy.ts";
import { readHeader } from "../Names.ts";

/** `allowInsecure` lets tests use a plain-HTTP fake upstream. */
export const egressLayer = (token: string, options: { readonly allowInsecure?: boolean } = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      // Captured here so the route needs nothing from the server that runs it.
      const client = yield* HttpClient.HttpClient;
      return HttpRouter.add(
        "*",
        "/egress/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const given = readHeader(request.headers, "relay-token") ?? "";
          if (token === "" || !constantTimeEqual(yield* hashToken(given), yield* hashToken(token)))
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          const split = splitPath(request.url, "/egress");
          const base = readHeader(request.headers, "egress-base") ?? "";
          if (
            split === null ||
            !(
              base.startsWith("https://") ||
              (options.allowInsecure === true && base.startsWith("http://"))
            )
          ) {
            return HttpServerResponse.text("Bad Request", { status: 400 });
          }
          const body =
            request.method === "GET" || request.method === "HEAD"
              ? null
              : new Uint8Array(yield* request.arrayBuffer);
          const response = yield* sendUpstream({
            method: request.method,
            url: `${base}${split.rest}`,
            headers: requestHeaders(request.headers),
            body,
          });
          const contentType = response.headers["content-type"];
          return HttpServerResponse.stream(response.stream, {
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
  );
