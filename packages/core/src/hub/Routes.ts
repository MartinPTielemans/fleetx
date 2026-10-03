/**
 * The hub's HTTP surface on the relay:
 *
 *   GET    /hub/servers                    HubServer[]
 *   POST   /hub/servers/<name>/login       HubLoginStart: the URL to open
 *   POST   /hub/servers/<name>/logout      204
 *   POST   /hub/servers/<name>/restart     204
 *   GET    /hub/calls?server=&limit=       HubCall[], newest first
 *   GET    /hub/tokens                     client tokens: names, servers, dates
 *   POST   /hub/tokens/<client>            { token }, shown once; body { servers? }
 *   DELETE /hub/tokens/<client>            204, or 404
 *   GET    /oauth/callback                 finishes a sign-in (public; checks state)
 *   *      /mcp/<name>                     the gateway (relay token or a client token)
 *
 * Management needs the relay token. Responses are encoded with the shared
 * schemas in Api.ts, so the CLI and the UI decode exactly what is sent.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { HubCall, HubLoginStart, HubServer } from "../Api.ts";
import type { Hub } from "./Hub.ts";
import { parseJson } from "./JsonRpc.ts";
import { bearerMatches } from "./Policy.ts";
import type { ForwardRequest } from "./Upstream.ts";

export const ClientToken = Schema.Struct({ client: Schema.String, servers: Schema.NullOr(Schema.Array(Schema.String)), createdAt: Schema.Number });
export const CreatedToken = Schema.Struct({ token: Schema.String });

const encodeServers = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(HubServer)));
const encodeCalls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(HubCall)));
const encodeLogin = Schema.encodeEffect(Schema.fromJsonString(HubLoginStart));
const encodeTokens = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ClientToken)));
const encodeCreated = Schema.encodeEffect(Schema.fromJsonString(CreatedToken));

const json = (text: string, status = 200) => HttpServerResponse.text(text, { status, contentType: "application/json" });
const problem = (message: string, status: number) => HttpServerResponse.text(message, { status, contentType: "text/plain" });

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, message: string, status: number) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title>` +
      `<body style="font:15px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`,
    { status, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } },
  );

/** The segment after `prefix` in the path: /hub/servers/<name>/login → name. */
const segment = (url: string, index: number) => decodeURIComponent(new URL(url, "http://relay").pathname.split("/")[index] ?? "");

export const hubRoutes = (hub: Hub, relayToken: string) => {
  const authorized = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* bearerMatches(request.headers["authorization"], relayToken);
  });
  const unauthorized = problem("Unauthorized", 401);
  const guarded = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      if (!(yield* authorized)) return unauthorized;
      return yield* handler;
    }).pipe(Effect.catchCause(() => Effect.succeed(problem("Internal Server Error", 500))));

  const action = (verb: "login" | "logout" | "restart") =>
    HttpRouter.add(
      "POST",
      `/hub/servers/:name/${verb}`,
      guarded(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const name = segment(request.url, 3);
          if (verb === "login") {
            const url = yield* hub.login(name).pipe(Effect.result);
            if (url._tag === "Failure") return problem(url.failure, url.failure.startsWith("no hosted") ? 404 : 409);
            return json(yield* encodeLogin({ url: url.success }));
          }
          const done = yield* (verb === "logout" ? hub.logout(name) : hub.restart(name)).pipe(Effect.result);
          return done._tag === "Failure" ? problem(done.failure, 404) : HttpServerResponse.empty({ status: 204 });
        }),
      ),
    );

  return Layer.mergeAll(
    HttpRouter.add("GET", "/hub/servers", guarded(Effect.flatMap(hub.servers, encodeServers).pipe(Effect.map((t) => json(t))))),
    action("login"),
    action("logout"),
    action("restart"),
    HttpRouter.add(
      "GET",
      "/hub/calls",
      guarded(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://relay");
          const limit = Number(url.searchParams.get("limit") ?? "100");
          const calls = yield* hub.calls({ server: url.searchParams.get("server") ?? undefined, limit: Number.isFinite(limit) ? limit : 100 });
          return json(yield* encodeCalls(calls));
        }),
      ),
    ),
    HttpRouter.add("GET", "/hub/tokens", guarded(Effect.flatMap(hub.listTokens, encodeTokens).pipe(Effect.map((t) => json(t))))),
    HttpRouter.add(
      "POST",
      "/hub/tokens/:client",
      guarded(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = parseJson(yield* request.text) as { servers?: unknown } | undefined;
          const servers = Array.isArray(body?.servers) && body.servers.every((s) => typeof s === "string") && body.servers.length > 0 ? (body.servers as Array<string>) : null;
          const token = yield* hub.createToken(segment(request.url, 3), servers).pipe(Effect.result);
          if (token._tag === "Failure") return problem(token.failure, 400);
          return HttpServerResponse.text(yield* encodeCreated({ token: token.success }), { contentType: "application/json", headers: { "cache-control": "no-store" } });
        }),
      ),
    ),
    HttpRouter.add(
      "DELETE",
      "/hub/tokens/:client",
      guarded(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          return (yield* hub.revokeToken(segment(request.url, 3))) ? HttpServerResponse.empty({ status: 204 }) : problem("no such client token", 404);
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/oauth/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const query = Object.fromEntries(new URL(request.url, "http://relay").searchParams);
        const result = yield* hub.finishLogin(query).pipe(Effect.result);
        return result._tag === "Success"
          ? page(`Signed in to ${result.success}`, "The fleetx hub holds the login now. You can close this tab.", 200)
          : page("Sign-in failed", result.failure, 400);
      }).pipe(Effect.catchCause(() => Effect.succeed(page("Sign-in failed", "Something went wrong on the relay.", 500)))),
    ),
    HttpRouter.add(
      "*",
      "/mcp/:name",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const name = segment(request.url, 2);
        const method = request.method === "GET" || request.method === "DELETE" ? request.method : request.method === "POST" ? "POST" : null;
        if (method === null) return problem("Method Not Allowed", 405);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(request.headers)) if (typeof v === "string") headers[k] = v;
        const forward: ForwardRequest = { method, headers, body: method === "POST" ? yield* request.text : "" };
        const response = yield* hub.gateway(name, request.headers["authorization"], forward);
        const { "content-type": contentType, ...rest } = response.headers;
        return HttpServerResponse.stream(response.body, { status: response.status, ...(contentType === undefined ? {} : { contentType }), headers: rest });
      }).pipe(Effect.catchCause(() => Effect.succeed(problem("Bad Gateway", 502)))),
    ),
  );
};

/** Decoders for clients of these routes (the CLI, the UI server). */
export const decodeServers = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(HubServer)));
export const decodeCalls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(HubCall)));
export const decodeLogin = Schema.decodeUnknownEffect(Schema.fromJsonString(HubLoginStart));
export const decodeTokens = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ClientToken)));
export const decodeCreated = Schema.decodeUnknownEffect(Schema.fromJsonString(CreatedToken));
