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
 *   5. Tokens live in the encrypted token store, tied to the server URL they
 *      were issued for (the RFC 8707 resource): a definition pointing at
 *      another URL needs a new login, its old token is never sent there.
 *   6. Refresh happens ahead of expiry, and once for a rejected access token.
 *      One refresh runs per server at a time, in the hub's own scope, and
 *      every request that needs it waits for that one: a client hanging up
 *      cannot cut a refresh short after the server rotated the refresh token.
 *   7. A refresh the authorization server refuses (invalid_grant) drops the
 *      tokens: the server needs a login. invalid_client or
 *      unauthorized_client from the token endpoint drops the client
 *      registration too, so the next login registers again; an authorization
 *      callback never does. Any other failure (a 5xx, a 429, a timeout) keeps
 *      everything, backs off, and keeps sending the access token while it is
 *      still valid. A provider that refuses a dead refresh token without
 *      saying so (another 4xx) is taken at its word after the access token
 *      has expired and REFUSALS_BEFORE_LOGIN such answers.
 *
 * Tokens, codes, verifiers and client secrets are never logged.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { HubDefinition } from "./Definitions.ts";
import { parseJson } from "./JsonRpc.ts";
import { base64url, randomBytes, randomSecret, sha256Base64url } from "./Policy.ts";
import { withServer, type OAuthClient, type OAuthEndpoints, type OAuthTokens, type StoredServer, type TokenStore } from "./TokenStore.ts";

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

const LOOPBACK: ReadonlyArray<string> = ["127.0.0.1", "localhost", "[::1]"];

/** Whether a URL's host is this machine. */
export const isLoopback = (url: string) => {
  const u = URL.parse(url);
  return u !== null && LOOPBACK.includes(u.hostname);
};

/**
 * OAuth URLs must be HTTPS. Plain HTTP on loopback is allowed only when a
 * caller asks for it explicitly (tests); never by default.
 */
export const isSecureEndpoint = (url: string, allowLoopbackHttp = false) => {
  const u = URL.parse(url);
  return u !== null && (u.protocol === "https:" || (allowLoopbackHttp && u.protocol === "http:" && LOOPBACK.includes(u.hostname)));
};

/** Same scheme, host and port. */
const sameOrigin = (a: string, b: string) => URL.parse(a)?.origin === URL.parse(b)?.origin;

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
export const discover = (serverUrl: string, challenge: string | null, options: { readonly allowLoopbackHttp?: boolean } = {}) =>
  Effect.gen(function* () {
    const allow = options.allowLoopbackHttp === true;
    if (!isSecureEndpoint(serverUrl, allow)) return yield* new OAuthError({ message: `signing in needs an HTTPS server URL, not ${serverUrl}` });
    const params = parseWwwAuthenticate(challenge);
    // A resource_metadata hint is followed only on the server's own origin, over HTTPS; otherwise the well-known URLs are used.
    const hinted = params["resource_metadata"];
    const hint = hinted !== undefined && isSecureEndpoint(hinted, allow) && sameOrigin(hinted, serverUrl) ? [hinted] : [];
    const prm = yield* firstJson([...hint, ...resourceMetadataUrls(serverUrl)], ResourceMetadata);
    const resource = canonicalResource(serverUrl);
    if (Option.isSome(prm)) {
      // RFC 9728 §3.3: the metadata must be for this very resource.
      const named = prm.value.value.resource;
      if (named === undefined || URL.parse(named) === null || canonicalResource(named) !== resource) {
        return yield* new OAuthError({ message: `the resource metadata at ${prm.value.url} is for ${named ?? "no resource"}, not ${resource}` });
      }
    }
    const issuer = Option.match(prm, { onNone: () => new URL(serverUrl).origin, onSome: (p) => p.value.authorization_servers?.[0] ?? new URL(serverUrl).origin });
    if (!isSecureEndpoint(issuer, allow)) return yield* new OAuthError({ message: `the authorization server ${issuer} is not HTTPS` });
    const found = yield* firstJson(serverMetadataUrls(issuer), ServerMetadata);
    if (Option.isNone(found)) return yield* new OAuthError({ message: `no authorization server metadata found for ${issuer}` });
    const metadata = found.value.value;
    // RFC 8414 §3.3: the metadata must name the issuer it was fetched for.
    if (metadata.issuer !== issuer) {
      return yield* new OAuthError({ message: `the metadata for ${issuer} names a different issuer (${metadata.issuer ?? "none"})` });
    }
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) {
      if (endpoint !== undefined && !isSecureEndpoint(endpoint, allow)) {
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

/** The RFC 6749 error code of an OAuth error body, or null. */
const oauthErrorCode = (text: string) => {
  const value = parseJson(text) as { error?: unknown } | undefined;
  return typeof value?.error === "string" ? value.error : null;
};

/** Error codes that say the authorization server no longer knows the client: its registration is dead. */
const CLIENT_GONE: ReadonlyArray<string> = ["invalid_client", "unauthorized_client"];

const mapTransport = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OAuthError, R> =>
  effect.pipe(
    Effect.mapError((e) => (Schema.is(OAuthError)(e) ? e : new OAuthError({ message: `authorization server unreachable (${e._tag})` }))),
  );

export interface TokenRequestResult {
  readonly status: number;
  readonly tokens: OAuthTokens | null;
  /** The RFC 6749 error code, when the server sent one. */
  readonly code: string | null;
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
    if (response.status !== 200) return { status: response.status, tokens: null, code: oauthErrorCode(text), error: oauthErrorText(text) } satisfies TokenRequestResult;
    const decoded = Schema.decodeUnknownOption(TokenResponse)(parseJson(text));
    if (Option.isNone(decoded)) return { status: 502, tokens: null, code: null, error: "the token endpoint returned no access_token" } satisfies TokenRequestResult;
    const t = decoded.value;
    const tokens: OAuthTokens = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? previousRefresh,
      expiresAt: t.expires_in === undefined ? null : now + t.expires_in * 1000,
      issuedAt: now,
      scope: t.scope ?? null,
    };
    return { status: 200, tokens, code: null, error: "" } satisfies TokenRequestResult;
  }).pipe(Effect.timeout(Duration.seconds(15)), Effect.catchTag("TimeoutError", () => Effect.fail(new OAuthError({ message: "the token endpoint timed out" }))), mapTransport);

/** How a sign-in begun with `start` is going, looked up by its state. */
export const LoginStatus = Schema.Struct({
  status: Schema.Literals(["pending", "done", "failed", "unknown"]),
  server: Schema.NullOr(Schema.String),
  /** Why it failed. */
  detail: Schema.NullOr(Schema.String),
});
export type LoginStatus = typeof LoginStatus.Type;

/**
 * Where a token will be sent: the server URL, or null for a server on this
 * machine whose port changes (a container), which takes the server's login
 * whatever port it was issued for, but never one issued for another machine.
 */
export type TokenTarget = string | null;

export interface OAuthManager {
  /** Begin a login: the URL a person opens. */
  readonly start: (definition: HubDefinition, serverUrl: string, challenge: string | null) => Effect.Effect<string, OAuthError>;
  /** Finish a login from the callback's query; returns the server's name. */
  readonly finish: (query: Readonly<Record<string, string | undefined>>) => Effect.Effect<string, OAuthError>;
  /** How the sign-in with this state is going. */
  readonly loginStatus: (state: string) => Effect.Effect<LoginStatus>;
  /** A current access token for `target`, refreshed first when it is close to expiring. */
  readonly accessToken: (server: string, target: TokenTarget) => Effect.Effect<string, NeedsLogin | OAuthError>;
  /** The server rejected `rejected`: refresh once (unless another request already did). */
  readonly afterRejection: (server: string, target: TokenTarget, rejected: string) => Effect.Effect<string, NeedsLogin | OAuthError>;
  /** Sign out: drop the server's tokens and its dynamic client registration, so the next login starts afresh. */
  readonly forget: (server: string) => Effect.Effect<void>;
  readonly expiresAt: (server: string) => Effect.Effect<number | null>;
  /** Whether the server has tokens; with a target, tokens that may be sent there. */
  readonly hasTokens: (server: string, target?: TokenTarget) => Effect.Effect<boolean>;
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
/** After a refresh fails for a reason worth retrying, wait this long, doubling up to the maximum. */
export const REFRESH_BACKOFF = 10_000;
const REFRESH_BACKOFF_MAX = 5 * 60_000;
/** Answers like a 400 with no RFC 6749 code, after the access token expired, before the login counts as lost. */
export const REFUSALS_BEFORE_LOGIN = 3;
/** Refresh this long before the access token expires (or halfway, for tokens that live less than twice this). */
export const REFRESH_AHEAD = 5 * 60_000;

/** Whether a token is still good enough to send without refreshing first. */
export const isFresh = (t: OAuthTokens, now: number) => {
  if (t.expiresAt === null) return true;
  const lifetime = t.issuedAt === undefined ? Infinity : t.expiresAt - t.issuedAt;
  return t.expiresAt - now > Math.min(REFRESH_AHEAD, lifetime / 2);
};

/** Whether the server would still accept a token, fresh or not. */
const isValid = (t: OAuthTokens, now: number) => t.expiresAt === null || t.expiresAt > now;

export const makeOAuthManager = (options: {
  readonly store: TokenStore;
  /** Exactly `<relay url>/oauth/callback`. */
  readonly redirectUri: string;
  readonly secrets: Effect.Effect<Readonly<Record<string, string>>>;
  readonly clientName?: string;
  /** Tests only: accept plain-HTTP OAuth URLs on loopback. */
  readonly allowLoopbackHttp?: boolean;
  /** Tests only: the first wait after a failed refresh; default REFRESH_BACKOFF. */
  readonly refreshBackoff?: number;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    // Refreshes run here, not on the request that needed them.
    const scope = yield* Effect.scope;
    const provide = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) => Effect.provideService(effect, HttpClient.HttpClient, http);
    const pending = new Map<string, Pending>();
    const finished = new Map<string, LoginStatus & { readonly at: number }>();
    const refreshing = new Map<string, Deferred.Deferred<string, NeedsLogin | OAuthError>>();
    const backoff = new Map<string, { readonly failures: number; readonly until: number }>();
    /** Refresh answers that looked like a refusal without saying so, since the access token expired. */
    const refusals = new Map<string, number>();
    const clearBackoff = (server: string) => {
      backoff.delete(server);
      refusals.delete(server);
    };
    const firstBackoff = options.refreshBackoff ?? REFRESH_BACKOFF;

    const entry = (server: string) => options.store.get.pipe(Effect.map((s) => s.servers[server]));

    /** Whether the stored login may be sent to `target`. */
    const isFor = (stored: StoredServer, target: TokenTarget) => {
      if (target === null) return stored.endpoints !== undefined && isLoopback(stored.endpoints.resource);
      const resource = URL.parse(target) === null ? null : canonicalResource(target);
      return stored.endpoints !== undefined && stored.endpoints.resource === resource;
    };

    /** The tokens to use for `target`, or why there are none. */
    const tokensFor = (server: string, stored: StoredServer | undefined, target: TokenTarget) =>
      Effect.gen(function* () {
        if (stored?.tokens === undefined) return yield* new NeedsLogin({ server, message: "not signed in" });
        if (!isFor(stored, target)) {
          return yield* new NeedsLogin({ server, message: `the login is for ${stored.endpoints?.resource ?? "another address"}, not ${target ?? ""}; sign in again` });
        }
        return stored.tokens;
      });

    /** How long until the next refresh may be tried, in milliseconds; 0 when it may now. */
    const backingOff = (server: string, now: number) => Math.max(0, (backoff.get(server)?.until ?? 0) - now);

    const retryIn = (ms: number) => new OAuthError({ message: `refreshing the login failed; trying again in ${Math.ceil(ms / 1000)}s` });

    const clientFor = (definition: HubDefinition, discovery: Discovery) =>
      Effect.gen(function* () {
        const stat = definition.auth.type === "oauth" ? definition.auth.client : null;
        if (stat !== null) {
          // A static client's secret goes only to the issuer the definition names, never to one the server points at.
          if (discovery.issuer !== stat.issuer) {
            return yield* new OAuthError({ message: `the server sends sign-ins to ${discovery.issuer}, but mcp/${definition.name}.json names the issuer ${stat.issuer}` });
          }
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
        const registered = yield* provide(register(discovery.metadata, discovery.issuer, options.redirectUri, options.clientName ?? "T3 Fleet hub"));
        yield* options.store.update((s) => [undefined, withServer(s, definition.name, { ...s.servers[definition.name], client: registered })]);
        return registered;
      });

    const start: OAuthManager["start"] = (definition, serverUrl, challenge) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [state, p] of pending) if (now - p.createdAt > PENDING_FOR) pending.delete(state);
        if (pending.size >= MAX_PENDING) return yield* new OAuthError({ message: "too many sign-ins in progress; finish or wait for one to expire" });
        const discovery = yield* provide(discover(serverUrl, challenge, { allowLoopbackHttp: options.allowLoopbackHttp === true }));
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

    /**
     * Drop a client registration the token endpoint no longer knows. Tokens
     * issued to it stay until they expire; refreshing them then asks for a
     * login, and that login registers again.
     */
    const forgetClient = (server: string, client: OAuthClient) =>
      options.store.update((s) => {
        const current = s.servers[server];
        if (current?.client?.clientId !== client.clientId) return [undefined, s];
        const { endpoints, tokens } = current;
        return [undefined, withServer(s, server, endpoints === undefined || tokens === undefined ? null : { endpoints, tokens })];
      });

    /** Remember how a sign-in ended, for `loginStatus`. */
    const remember = (state: string, status: LoginStatus) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [key, f] of finished) if (now - f.at > PENDING_FOR || finished.size >= MAX_PENDING) finished.delete(key);
        finished.set(state, { ...status, at: now });
      });

    const complete = (p: Pending, query: Readonly<Record<string, string | undefined>>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - p.createdAt > PENDING_FOR) return yield* new OAuthError({ message: "this sign-in expired; start it again" });
        const refused = query["error"];
        // Refused here (a policy, a scope) says nothing about the client: a working login stays as it is.
        if (refused !== undefined) {
          return yield* new OAuthError({ message: `the authorization server refused: ${[refused, query["error_description"]].filter(Boolean).join(": ").slice(0, 200)}` });
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
        if (result.tokens === null) {
          if (result.code !== null && CLIENT_GONE.includes(result.code)) yield* forgetClient(p.server, p.client);
          return yield* new OAuthError({ message: `the token exchange failed: HTTP ${result.status} ${result.error}` });
        }
        const tokens = result.tokens;
        yield* options.store.update((s) => [undefined, withServer(s, p.server, { client: p.client, endpoints: p.endpoints, tokens })]);
        clearBackoff(p.server);
        return p.server;
      });

    const finish: OAuthManager["finish"] = (query) =>
      Effect.gen(function* () {
        const state = query["state"] ?? "";
        const p = pending.get(state);
        if (p === undefined) return yield* new OAuthError({ message: "this sign-in is unknown or was already used; start it again" });
        pending.delete(state);
        return yield* complete(p, query).pipe(
          Effect.tap(() => remember(state, { status: "done", server: p.server, detail: null })),
          Effect.tapError((e) => remember(state, { status: "failed", server: p.server, detail: e.message })),
        );
      });

    const loginStatus: OAuthManager["loginStatus"] = (state) =>
      Effect.sync((): LoginStatus => {
        const p = pending.get(state);
        if (p !== undefined) return { status: "pending", server: p.server, detail: null };
        const f = finished.get(state);
        return f === undefined ? { status: "unknown", server: null, detail: null } : { status: f.status, server: f.server, detail: f.detail };
      });

    /**
     * One refresh against the authorization server. A refused one drops the
     * tokens (and, when the client is gone, its registration); any other
     * failure keeps them and starts a backoff.
     */
    const refreshNow = (server: string) =>
      Effect.gen(function* () {
        const e = yield* entry(server);
        if (e?.tokens === undefined || e.endpoints === undefined) return yield* new NeedsLogin({ server, message: "not signed in" });
        const used = e.tokens;
        // A sign-in or sign-out while this refresh ran wins over its outcome.
        const ifUnchanged = (next: (current: StoredServer) => StoredServer | null) =>
          options.store.update((s) => {
            const current = s.servers[server];
            return [undefined, current?.tokens === used ? withServer(s, server, next(current)) : s];
          });
        const withoutTokens = (current: StoredServer): StoredServer => ({
          ...(current.client === undefined ? {} : { client: current.client }),
          ...(current.endpoints === undefined ? {} : { endpoints: current.endpoints }),
        });
        if (e.client === undefined) {
          yield* ifUnchanged(() => null);
          return yield* new NeedsLogin({ server, message: "the login has no client registration" });
        }
        const { client, endpoints } = e;
        if (used.refreshToken === null) {
          yield* ifUnchanged(withoutTokens);
          return yield* new NeedsLogin({ server, message: "the access token expired and there is no refresh token" });
        }
        const result = yield* provide(
          tokenRequest(endpoints.tokenEndpoint, client, { grant_type: "refresh_token", refresh_token: used.refreshToken, resource: endpoints.resource }, used.refreshToken),
        );
        if (result.tokens !== null) {
          const tokens = result.tokens;
          yield* ifUnchanged((current) => ({ ...current, tokens }));
          clearBackoff(server);
          return tokens.accessToken;
        }
        const refused = `refreshing the login was refused (${result.error || `HTTP ${result.status}`})`;
        if (result.code !== null && CLIENT_GONE.includes(result.code)) {
          yield* ifUnchanged(() => null);
          return yield* new NeedsLogin({ server, message: refused });
        }
        if (result.code === "invalid_grant") {
          yield* ifUnchanged(withoutTokens);
          return yield* new NeedsLogin({ server, message: refused });
        }
        // A 4xx without a code we act on (an HTML page, invalid_request) may be a dead refresh token after all.
        if (result.status >= 400 && result.status < 500 && result.status !== 429 && !isValid(used, yield* Clock.currentTimeMillis)) {
          const count = (refusals.get(server) ?? 0) + 1;
          refusals.set(server, count);
          if (count >= REFUSALS_BEFORE_LOGIN) {
            yield* ifUnchanged(withoutTokens);
            return yield* new NeedsLogin({ server, message: `${refused}, ${count} times since the access token expired` });
          }
        }
        return yield* new OAuthError({ message: `refreshing the login failed: ${result.error || `HTTP ${result.status}`}` });
      }).pipe(
        Effect.tapError((e) =>
          e._tag === "NeedsLogin"
            ? Effect.sync(() => clearBackoff(server))
            : Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const failures = (backoff.get(server)?.failures ?? 0) + 1;
                const expiresAt = (yield* entry(server))?.tokens?.expiresAt ?? null;
                // Try again at expiry at the latest, so a token that could be refreshed then is.
                const wait = Math.min(firstBackoff * 2 ** (failures - 1), REFRESH_BACKOFF_MAX);
                backoff.set(server, { failures, until: expiresAt !== null && expiresAt > now ? Math.min(now + wait, expiresAt) : now + wait });
              }),
        ),
      );

    /**
     * The server's refresh: the one running, or a new one in the hub's scope.
     * Waiting can be interrupted; the refresh itself is not.
     */
    const refresh = (server: string) =>
      Effect.sync(() => {
        const running = refreshing.get(server);
        if (running !== undefined) return { deferred: running, started: false };
        const deferred = Deferred.makeUnsafe<string, NeedsLogin | OAuthError>();
        refreshing.set(server, deferred);
        return { deferred, started: true };
      }).pipe(
        Effect.tap(({ deferred, started }) =>
          started
            ? refreshNow(server).pipe(
                Effect.onExit((exit) => Effect.sync(() => refreshing.delete(server)).pipe(Effect.andThen(Deferred.done(deferred, exit)))),
                Effect.interruptible,
                Effect.forkIn(scope),
              )
            : Effect.void,
        ),
        Effect.uninterruptible,
        Effect.flatMap(({ deferred }) => Deferred.await(deferred)),
      );

    const accessToken: OAuthManager["accessToken"] = (server, target) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const before = yield* tokensFor(server, yield* entry(server), target);
        if (isFresh(before, now)) return before.accessToken;
        // Nothing to refresh with: use the token until it expires.
        if (before.refreshToken === null && isValid(before, now)) return before.accessToken;
        const wait = backingOff(server, now);
        if (wait > 0) return isValid(before, now) ? before.accessToken : yield* retryIn(wait);
        return yield* refresh(server).pipe(
          Effect.catchTag("OAuthError", (e) =>
            Effect.gen(function* () {
              // The authorization server is having trouble; the token it issued still works.
              const current = (yield* entry(server))?.tokens;
              if (current !== undefined && current.accessToken === before.accessToken && isValid(current, yield* Clock.currentTimeMillis)) return current.accessToken;
              return yield* e;
            }),
          ),
        );
      });

    const afterRejection: OAuthManager["afterRejection"] = (server, target, rejected) =>
      Effect.gen(function* () {
        const current = yield* tokensFor(server, yield* entry(server), target);
        // Another request refreshed already.
        if (current.accessToken !== rejected) return current.accessToken;
        const wait = backingOff(server, yield* Clock.currentTimeMillis);
        if (wait > 0) return yield* retryIn(wait);
        return yield* refresh(server);
      });

    const manager: OAuthManager = {
      start,
      finish,
      loginStatus,
      accessToken,
      afterRejection,
      // A provider may forget a dynamic client without saying so; signing out and in again then registers a new one.
      forget: (server) => options.store.update((s) => [undefined, withServer(s, server, null)]).pipe(Effect.andThen(Effect.sync(() => clearBackoff(server)))),
      expiresAt: (server) => entry(server).pipe(Effect.map((e) => e?.tokens?.expiresAt ?? null)),
      hasTokens: (server, target) => entry(server).pipe(Effect.map((e) => e?.tokens !== undefined && (target === undefined || isFor(e, target)))),
    };
    return manager;
  });
