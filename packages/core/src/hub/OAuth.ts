/**
 * The hub as an OAuth client, per the MCP authorization spec (2025-06-18).
 *
 *   1. A 401 whose WWW-Authenticate names `resource_metadata` (or a
 *      definition with remote_auth) means the server needs a login.
 *   2. Discovery: the protected resource metadata (RFC 9728), then the
 *      authorization server's metadata (RFC 8414, then OpenID discovery).
 *   3. The client: registered dynamically (RFC 7591) when the server offers
 *      it, else the definition's static `oauth = { client_id … }`.
 *   4. Authorization code with PKCE S256, the RFC 8707 `resource`, and
 *      `redirect_uri = <relay url>/oauth/callback`, so a person signs in from
 *      any browser on the tailnet.
 *   5. Tokens live in the encrypted token store. Refresh is serialized per
 *      server and happens ahead of expiry; a rejected access token gets one
 *      refresh. A refused refresh drops the tokens: the server needs a login.
 *
 * Tokens, codes, verifiers and client secrets are never logged.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { HubDefinition } from "./Definitions.ts";
import { parseJson } from "./JsonRpc.ts";
import { base64url, randomBytes, randomSecret, sha256Base64url } from "./Policy.ts";
import { withServer, type OAuthClient, type OAuthEndpoints, type OAuthTokens, type TokenStore } from "./TokenStore.ts";

/** Something went wrong talking to an authorization server; worth retrying later. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", { message: Schema.String }) {}

/** The server has no usable login; a person must sign in. */
export class NeedsLogin extends Schema.TaggedError<NeedsLogin>()("NeedsLogin", { server: Schema.String, message: Schema.String }) {}

const ResourceMetadata = Schema.Struct({
  resource: Schema.optionalKey(Schema.String),
  authorization_servers: Schema.optionalKey(Schema.Array(Schema.String)),
  scopes_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const ServerMetadata = Schema.Struct({
  issuer: Schema.optionalKey(Schema.String),
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optionalKey(Schema.String),
  code_challenge_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ServerMetadata = typeof ServerMetadata.Type;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
});

const RegistrationResponse = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
  token_endpoint_auth_method: Schema.optionalKey(Schema.String),
});

/** The parameters of a `WWW-Authenticate: Bearer …` challenge. */
export const parseWwwAuthenticate = (header: string | null | undefined): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const m of (header ?? "").matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    out[(m[1] ?? "").toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return out;
};

/** A server URL as an RFC 8707 resource: no fragment, no trailing slash on a bare origin. */
export const canonicalResource = (url: string) => {
  const u = new URL(url);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
};

const pathOf = (url: string) => {
  const p = new URL(url).pathname;
  return p === "/" ? "" : p.replace(/\/+$/, "");
};

/** RFC 9728 §3: the path-specific well-known URL first, then the root one. */
export const resourceMetadataUrls = (serverUrl: string) => {
  const u = new URL(serverUrl);
  const path = pathOf(serverUrl);
  const root = `${u.origin}/.well-known/oauth-protected-resource`;
  return path === "" ? [root] : [`${root}${path}`, root];
};

/** RFC 8414 §3.1 first, then OpenID discovery with the path inserted and appended. */
export const serverMetadataUrls = (issuer: string) => {
  const u = new URL(issuer);
  const path = pathOf(issuer);
  return path === ""
    ? [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
    : [
        `${u.origin}/.well-known/oauth-authorization-server${path}`,
        `${u.origin}/.well-known/openid-configuration${path}`,
        `${u.origin}${path}/.well-known/openid-configuration`,
      ];
};

const getJson = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("accept", "application/json")));
    if (response.status !== 200) return Option.none<unknown>();
    const text = yield* response.text;
    const value = parseJson(text);
    return value === undefined ? Option.none<unknown>() : Option.some(value);
  }).pipe(Effect.timeout(Duration.seconds(10)), Effect.orElseSucceed(() => Option.none<unknown>()));

const firstJson = <A>(urls: ReadonlyArray<string>, schema: Schema.Decoder<A>) =>
  Effect.gen(function* () {
    for (const url of urls) {
      const value = yield* getJson(url);
      if (Option.isNone(value)) continue;
      const decoded = Schema.decodeUnknownOption(schema)(value.value);
      if (Option.isSome(decoded)) return Option.some({ url, value: decoded.value });
    }
    return Option.none<{ url: string; value: A }>();
  });

/** Authorization server endpoints must be HTTPS; plain HTTP only on loopback (development, tests). */
export const isSecureEndpoint = (url: string) => {
  const u = URL.parse(url);
  return u !== null && (u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)));
};

export interface Discovery {
  readonly resource: string;
  readonly issuer: string;
  readonly metadata: ServerMetadata;
  /** Scopes the resource or its challenge suggests, when the definition names none. */
  readonly scopes: ReadonlyArray<string>;
}

/**
 * Find where to sign in for a server. `challenge` is the WWW-Authenticate
 * header of its 401, when there was one. A server without resource metadata
 * is taken to be its own authorization server (the 2025-03-26 behaviour).
 */
export const discover = (serverUrl: string, challenge: string | null) =>
  Effect.gen(function* () {
    const params = parseWwwAuthenticate(challenge);
    const hinted = params["resource_metadata"];
    const urls = hinted === undefined ? resourceMetadataUrls(serverUrl) : [hinted, ...resourceMetadataUrls(serverUrl)];
    const prm = yield* firstJson(urls, ResourceMetadata);
    const resource = Option.match(prm, { onNone: () => canonicalResource(serverUrl), onSome: (p) => p.value.resource ?? canonicalResource(serverUrl) });
    const issuer = Option.match(prm, { onNone: () => new URL(serverUrl).origin, onSome: (p) => p.value.authorization_servers?.[0] ?? new URL(serverUrl).origin });
    const found = yield* firstJson(serverMetadataUrls(issuer), ServerMetadata);
    if (Option.isNone(found)) return yield* new OAuthError({ message: `no authorization server metadata found for ${issuer}` });
    const metadata = found.value.value;
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
      if (endpoint !== undefined && !isSecureEndpoint(endpoint)) {
        return yield* new OAuthError({ message: `${issuer} names an endpoint that is not HTTPS: ${endpoint}` });
      }
    }
    const methods = metadata.code_challenge_methods_supported;
    if (methods !== undefined && !methods.includes("S256")) {
      return yield* new OAuthError({ message: `${issuer} does not support PKCE with S256` });
    }
    const scopes = params["scope"]?.split(/\s+/).filter((s) => s !== "") ?? Option.match(prm, { onNone: () => [], onSome: (p) => p.value.scopes_supported ?? [] });
    return { resource, issuer, metadata, scopes } satisfies Discovery;
  });

/** RFC 7591 dynamic registration of the hub as a public client. */
export const register = (metadata: ServerMetadata, issuer: string, redirectUri: string, clientName: string) =>
  Effect.gen(function* () {
    if (metadata.registration_endpoint === undefined) {
      return yield* new OAuthError({ message: "the authorization server offers no dynamic client registration" });
    }
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(metadata.registration_endpoint).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyJson({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
    const response = yield* client.execute(request);
    const text = yield* response.text;
    if (response.status < 200 || response.status >= 300) {
      return yield* new OAuthError({ message: `client registration failed: HTTP ${response.status} ${oauthErrorText(text)}` });
    }
    const decoded = Schema.decodeUnknownOption(RegistrationResponse)(parseJson(text));
    if (Option.isNone(decoded)) return yield* new OAuthError({ message: "client registration returned no client_id" });
    const r = decoded.value;
    const authMethod: OAuthClient["authMethod"] =
      r.client_secret === undefined
        ? "none"
        : r.token_endpoint_auth_method === "client_secret_post"
          ? "client_secret_post"
          : "client_secret_basic";
    return { clientId: r.client_id, clientSecret: r.client_secret ?? null, authMethod, redirectUri, issuer, registered: true } satisfies OAuthClient;
  }).pipe(Effect.timeout(Duration.seconds(15)), Effect.catchTag("TimeoutError", () => Effect.fail(new OAuthError({ message: "client registration timed out" }))), mapTransport);

/** The `error` and `error_description` of an OAuth error body, for messages; never anything else from it. */
const oauthErrorText = (text: string) => {
  const value = parseJson(text) as { error?: unknown; error_description?: unknown } | undefined;
  const parts = [value?.error, value?.error_description].filter((p): p is string => typeof p === "string");
  return parts.join(": ").slice(0, 200);
};

const mapTransport = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OAuthError, R> =>
  effect.pipe(
    Effect.mapError((e) => (Schema.is(OAuthError)(e) ? e : new OAuthError({ message: `authorization server unreachable (${e._tag})` }))),
  );

export interface TokenRequestResult {
  readonly status: number;
  readonly tokens: OAuthTokens | null;
  readonly error: string;
}

/** POST to the token endpoint with the client's authentication. */
const tokenRequest = (tokenEndpoint: string, client: OAuthClient, params: Record<string, string>, previousRefresh: string | null) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const body: Record<string, string> = { ...params };
    if (client.authMethod !== "client_secret_basic") body["client_id"] = client.clientId;
    if (client.authMethod === "client_secret_post" && client.clientSecret !== null) body["client_secret"] = client.clientSecret;
    let request = HttpClientRequest.post(tokenEndpoint).pipe(HttpClientRequest.setHeader("accept", "application/json"), HttpClientRequest.bodyUrlParams(body));
    if (client.authMethod === "client_secret_basic" && client.clientSecret !== null) {
      request = HttpClientRequest.basicAuth(request, encodeURIComponent(client.clientId), encodeURIComponent(client.clientSecret));
    }
    const response = yield* http.execute(request);
    const text = yield* response.text;
    const now = yield* Clock.currentTimeMillis;
    if (response.status !== 200) return { status: response.status, tokens: null, error: oauthErrorText(text) } satisfies TokenRequestResult;
    const decoded = Schema.decodeUnknownOption(TokenResponse)(parseJson(text));
    if (Option.isNone(decoded)) return { status: 502, tokens: null, error: "the token endpoint returned no access_token" } satisfies TokenRequestResult;
    const t = decoded.value;
    const tokens: OAuthTokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? previousRefresh,
      expiresAt: t.expires_in === undefined ? null : now + t.expires_in * 1000,
      issuedAt: now,
      scope: t.scope ?? null,
    };
    return { status: 200, tokens, error: "" } satisfies TokenRequestResult;
  }).pipe(Effect.timeout(Duration.seconds(15)), Effect.catchTag("TimeoutError", () => Effect.fail(new OAuthError({ message: "the token endpoint timed out" }))), mapTransport);

export interface OAuthManager {
  /** Begin a login: the URL a person opens. */
  readonly start: (definition: HubDefinition, serverUrl: string, challenge: string | null) => Effect.Effect<string, OAuthError>;
  /** Finish a login from the callback's query; returns the server's name. */
  readonly finish: (query: Readonly<Record<string, string | undefined>>) => Effect.Effect<string, OAuthError>;
  /** A current access token, refreshed first when it is close to expiring. */
  readonly accessToken: (server: string) => Effect.Effect<string, NeedsLogin | OAuthError>;
  /** The server rejected `rejected`: refresh once (unless another request already did). */
  readonly afterRejection: (server: string, rejected: string) => Effect.Effect<string, NeedsLogin | OAuthError>;
  /** Drop the server's tokens (sign out); its client registration is kept. */
  readonly forget: (server: string) => Effect.Effect<void>;
  readonly expiresAt: (server: string) => Effect.Effect<number | null>;
  readonly hasTokens: (server: string) => Effect.Effect<boolean>;
}

interface Pending {
  readonly server: string;
  readonly verifier: string;
  readonly client: OAuthClient;
  readonly endpoints: OAuthEndpoints;
  readonly createdAt: number;
}

const PENDING_FOR = 10 * 60_000;
const MAX_PENDING = 64;
/** Refresh this long before the access token expires (or halfway, for tokens that live less than twice this). */
export const REFRESH_AHEAD = 5 * 60_000;

/** Whether a token is still good enough to send without refreshing first. */
export const isFresh = (t: OAuthTokens, now: number) => {
  if (t.expiresAt === null) return true;
  const lifetime = t.issuedAt === undefined ? Infinity : t.expiresAt - t.issuedAt;
  return t.expiresAt - now > Math.min(REFRESH_AHEAD, lifetime / 2);
};

export const makeOAuthManager = (options: {
  readonly store: TokenStore;
  /** Exactly `<relay url>/oauth/callback`. */
  readonly redirectUri: string;
  readonly secrets: Effect.Effect<Readonly<Record<string, string>>>;
  readonly clientName?: string;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const provide = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provideService(effect, HttpClient.HttpClient, http);
    const pending = new Map<string, Pending>();
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockFor = (server: string) => {
      let lock = locks.get(server);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(server, lock);
      }
      return lock;
    };

    const entry = (server: string) => options.store.get.pipe(Effect.map((s) => s.servers[server]));

    const clientFor = (definition: HubDefinition, discovery: Discovery) =>
      Effect.gen(function* () {
        const stat = definition.auth.type === "oauth" ? definition.auth.client : null;
        if (stat !== null) {
          const secrets = yield* options.secrets;
          const secret = stat.clientSecretEnv === null ? null : (secrets[stat.clientSecretEnv] ?? null);
          if (stat.clientSecretEnv !== null && secret === null) {
            return yield* new OAuthError({ message: `the client secret ${stat.clientSecretEnv} is not in this node's secrets` });
          }
          const supported = discovery.metadata.token_endpoint_auth_methods_supported;
          const authMethod: OAuthClient["authMethod"] =
            secret === null ? "none" : supported !== undefined && !supported.includes("client_secret_basic") && supported.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
          return { clientId: stat.clientId, clientSecret: secret, authMethod, redirectUri: options.redirectUri, issuer: discovery.issuer, registered: false } satisfies OAuthClient;
        }
        const existing = (yield* entry(definition.name))?.client;
        if (existing !== undefined && existing.registered && existing.issuer === discovery.issuer && existing.redirectUri === options.redirectUri) return existing;
        if (discovery.metadata.registration_endpoint === undefined) {
          return yield* new OAuthError({
            message: `${discovery.issuer} offers no dynamic client registration; register a client there with redirect URI ${options.redirectUri} and add oauth = { client_id = "…", client_secret_env = "…" } to mcp/${definition.name}.json`,
          });
        }
        const registered = yield* provide(register(discovery.metadata, discovery.issuer, options.redirectUri, options.clientName ?? "fleetx hub"));
        yield* options.store.update((s) => [undefined, withServer(s, definition.name, { ...s.servers[definition.name], client: registered })]);
        return registered;
      });

    const start: OAuthManager["start"] = (definition, serverUrl, challenge) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [state, p] of pending) if (now - p.createdAt > PENDING_FOR) pending.delete(state);
        if (pending.size >= MAX_PENDING) return yield* new OAuthError({ message: "too many sign-ins in progress; finish or wait for one to expire" });
        const discovery = yield* provide(discover(serverUrl, challenge));
        const client = yield* clientFor(definition, discovery);
        const verifier = randomSecret() + randomSecret();
        const challengeValue = yield* sha256Base64url(verifier);
        const state = base64url(randomBytes(32));
        const endpoints: OAuthEndpoints = {
          authorizationEndpoint: discovery.metadata.authorization_endpoint,
          tokenEndpoint: discovery.metadata.token_endpoint,
          resource: discovery.resource,
        };
        pending.set(state, { server: definition.name, verifier, client, endpoints, createdAt: now });
        const scopes = definition.auth.type === "oauth" && definition.auth.scopes.length > 0 ? definition.auth.scopes : discovery.scopes;
        const url = new URL(endpoints.authorizationEndpoint);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", client.clientId);
        url.searchParams.set("redirect_uri", options.redirectUri);
        url.searchParams.set("code_challenge", challengeValue);
        url.searchParams.set("code_challenge_method", "S256");
        url.searchParams.set("state", state);
        url.searchParams.set("resource", endpoints.resource);
        if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
        return url.toString();
      });

    const finish: OAuthManager["finish"] = (query) =>
      Effect.gen(function* () {
        const state = query["state"] ?? "";
        const p = pending.get(state);
        if (p === undefined) return yield* new OAuthError({ message: "this sign-in is unknown or was already used; start it again" });
        pending.delete(state);
        const now = yield* Clock.currentTimeMillis;
        if (now - p.createdAt > PENDING_FOR) return yield* new OAuthError({ message: "this sign-in expired; start it again" });
        if (query["error"] !== undefined) {
          return yield* new OAuthError({ message: `the authorization server refused: ${[query["error"], query["error_description"]].filter(Boolean).join(": ").slice(0, 200)}` });
        }
        const code = query["code"];
        if (code === undefined || code === "") return yield* new OAuthError({ message: "the callback carried no code" });
        const result = yield* provide(
          tokenRequest(
            p.endpoints.tokenEndpoint,
            p.client,
            { grant_type: "authorization_code", code, redirect_uri: p.client.redirectUri, code_verifier: p.verifier, resource: p.endpoints.resource },
            null,
          ),
        );
        if (result.tokens === null) return yield* new OAuthError({ message: `the token exchange failed: HTTP ${result.status} ${result.error}` });
        const tokens = result.tokens;
        yield* options.store.update((s) => [undefined, withServer(s, p.server, { client: p.client, endpoints: p.endpoints, tokens })]);
        return p.server;
      });

    /** Under the server's lock: refresh, or drop the tokens when the server refuses. */
    const refreshLocked = (server: string) =>
      Effect.gen(function* () {
        const e = yield* entry(server);
        if (e?.tokens === undefined || e.client === undefined || e.endpoints === undefined) {
          return yield* new NeedsLogin({ server, message: "not signed in" });
        }
        const { client, endpoints } = e;
        if (e.tokens.refreshToken === null) {
          yield* options.store.update((s) => [undefined, withServer(s, server, { client, endpoints })]);
          return yield* new NeedsLogin({ server, message: "the access token expired and there is no refresh token" });
        }
        const result = yield* provide(
          tokenRequest(e.endpoints.tokenEndpoint, e.client, { grant_type: "refresh_token", refresh_token: e.tokens.refreshToken, resource: e.endpoints.resource }, e.tokens.refreshToken),
        );
        if (result.tokens !== null) {
          const tokens = result.tokens;
          yield* options.store.update((s) => [undefined, withServer(s, server, { ...s.servers[server], tokens })]);
          return tokens.accessToken;
        }
        if (result.status >= 400 && result.status < 500) {
          yield* options.store.update((s) => [undefined, withServer(s, server, { client, endpoints })]);
          return yield* new NeedsLogin({ server, message: `refreshing the login was refused (${result.error || `HTTP ${result.status}`})` });
        }
        return yield* new OAuthError({ message: `refreshing the login failed: HTTP ${result.status}` });
      });

    const accessToken: OAuthManager["accessToken"] = (server) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const before = (yield* entry(server))?.tokens;
        if (before === undefined) return yield* new NeedsLogin({ server, message: "not signed in" });
        if (isFresh(before, now)) return before.accessToken;
        return yield* Semaphore.withPermit(
          lockFor(server),
          Effect.gen(function* () {
            const current = (yield* entry(server))?.tokens;
            // Another request refreshed while this one waited for the lock.
            if (current !== undefined && (current.accessToken !== before.accessToken || isFresh(current, yield* Clock.currentTimeMillis))) return current.accessToken;
            return yield* refreshLocked(server);
          }),
        );
      });

    const afterRejection: OAuthManager["afterRejection"] = (server, rejected) =>
      Semaphore.withPermit(
        lockFor(server),
        Effect.gen(function* () {
          const current = (yield* entry(server))?.tokens;
          if (current !== undefined && current.accessToken !== rejected) return current.accessToken;
          return yield* refreshLocked(server);
        }),
      );

    const manager: OAuthManager = {
      start,
      finish,
      accessToken,
      afterRejection,
      forget: (server) =>
        options.store.update((s) => {
          const e = s.servers[server];
          return [undefined, withServer(s, server, e === undefined ? null : e.client === undefined ? {} : { client: e.client })];
        }),
      expiresAt: (server) => entry(server).pipe(Effect.map((e) => e?.tokens?.expiresAt ?? null)),
      hasTokens: (server) => entry(server).pipe(Effect.map((e) => e?.tokens !== undefined)),
    };
    return manager;
  });
