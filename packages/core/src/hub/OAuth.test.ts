// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { generateX25519Identity } from "age-encryption";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { isProblem, parseDefinition, type HubDefinition } from "./Definitions.ts";
import { makeOAuthManager, type NeedsLogin, type OAuthError, type OAuthManager } from "./OAuth.ts";
import { fakeAuthServer, fakeProtectedMcp, type FakeAuthServer, type FakeMcpServer } from "./testing/fakes.ts";
import { makeTokenStore, type TokenStore } from "./TokenStore.ts";

const BACKOFF = 200;

let identity: string;
beforeAll(async () => {
  identity = await generateX25519Identity();
});

interface World {
  readonly as: FakeAuthServer;
  readonly mcp: FakeMcpServer;
  readonly target: string;
  readonly store: TokenStore;
  readonly manager: OAuthManager;
  readonly definition: HubDefinition;
  /** Sign in as a person would; returns the access token. */
  readonly signIn: Effect.Effect<string, OAuthError | NeedsLogin>;
}

/** A fresh authorization server, a server it protects, and an OAuth manager with its own token store. */
// Effect.flip turns an unexpected success (a token) into the failure: string.
const withWorld = async (test: (world: World) => Effect.Effect<void, OAuthError | NeedsLogin | string, Scope.Scope | NodeServices.NodeServices | HttpClient.HttpClient>) => {
  let mcp: FakeMcpServer | null = null;
  const as = await fakeAuthServer({ openIdOnly: false, expectedResource: () => `${mcp?.url ?? ""}/mcp` });
  mcp = await fakeProtectedMcp(() => as.url, (t) => as.isValid(t));
  const target = `${mcp.url}/mcp`;
  const parsed = parseDefinition("svc", JSON.stringify({ kind: "remote", url: target, remote_auth: true }));
  if (isProblem(parsed)) throw new Error(parsed.problem);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeTokenStore({ file: join(mkdtempSync(join(tmpdir(), "t3-fleet-oauth-")), "tokens.age"), identity });
        const manager = yield* makeOAuthManager({ store, redirectUri: "https://relay.example.test/oauth/callback", secrets: Effect.succeed({}), allowLoopbackHttp: true, refreshBackoff: BACKOFF });
        const signIn = Effect.gen(function* () {
          const url = yield* manager.start(parsed, target, null);
          yield* manager.finish({ code: as.approve(url), state: new URL(url).searchParams.get("state") ?? "" });
          return yield* manager.accessToken("svc", target);
        });
        yield* test({ as, mcp: mcp as FakeMcpServer, target, store, manager, definition: parsed, signIn });
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
    );
  } finally {
    await as.close();
    await mcp.close();
  }
};

describe("hub OAuth refresh", () => {
  it("keeps the login when the token endpoint answers 429, and backs off before asking again", () =>
    withWorld(({ as, target, manager, signIn }) =>
      Effect.gen(function* () {
        const token = yield* signIn;
        as.failRefresh({ status: 429, body: { error: "slow_down" } });
        const failed = yield* manager.afterRejection("svc", target, token).pipe(Effect.flip);
        expect(failed._tag).toBe("OAuthError");
        expect(yield* manager.hasTokens("svc")).toBe(true);
        expect(as.refreshes()).toBe(1);

        // Within the backoff nobody asks the authorization server again.
        as.failRefresh(null);
        expect((yield* manager.afterRejection("svc", target, token).pipe(Effect.flip))._tag).toBe("OAuthError");
        expect(as.refreshes()).toBe(1);

        yield* Effect.sleep(Duration.millis(BACKOFF + 50));
        const next = yield* manager.afterRejection("svc", target, token);
        expect(next).not.toBe(token);
        expect(as.isValid(next)).toBe(true);
      }),
    ));

  it("drops only the tokens on invalid_grant, and the registration too on invalid_client", () =>
    withWorld(({ as, target, store, manager, definition, signIn }) =>
      Effect.gen(function* () {
        let token = yield* signIn;
        as.refuseRefresh(true);
        expect((yield* manager.afterRejection("svc", target, token).pipe(Effect.flip))._tag).toBe("NeedsLogin");
        expect((yield* store.get).servers["svc"]?.client?.clientId).toBe("client-1");
        expect(yield* manager.hasTokens("svc")).toBe(false);
        as.refuseRefresh(false);

        // The registration is reused while the authorization server knows it…
        token = yield* signIn;
        expect(as.registrations()).toBe(1);

        // …and forgotten once it says it does not.
        as.forgetClients();
        expect((yield* manager.afterRejection("svc", target, token).pipe(Effect.flip))._tag).toBe("NeedsLogin");
        expect((yield* store.get).servers["svc"]).toBeUndefined();
        yield* manager.start(definition, target, null);
        expect(as.registrations()).toBe(2);
      }),
    ));

  it("keeps a working login when a new sign-in is refused, and forgets only the registration when the token endpoint does", () =>
    withWorld(({ as, target, store, manager, definition, signIn }) =>
      Effect.gen(function* () {
        const token = yield* signIn;
        const stateOf = (url: string) => new URL(url).searchParams.get("state") ?? "";

        // Refused at the authorization endpoint (a policy, a scope): nothing changes.
        const refused = yield* manager.start(definition, target, null);
        yield* manager.finish({ state: stateOf(refused), error: "unauthorized_client" }).pipe(Effect.flip);
        expect((yield* store.get).servers["svc"]?.client?.clientId).toBe("client-1");
        expect(yield* manager.accessToken("svc", target)).toBe(token);

        // The token endpoint no longer knows the client: the registration goes, the working token stays.
        const forgotten = yield* manager.start(definition, target, null);
        const code = as.approve(forgotten);
        as.forgetClients();
        yield* manager.finish({ code, state: stateOf(forgotten) }).pipe(Effect.flip);
        expect((yield* store.get).servers["svc"]?.client).toBeUndefined();
        expect(yield* manager.accessToken("svc", target)).toBe(token);
        yield* manager.start(definition, target, null);
        expect(as.registrations()).toBe(2);
      }),
    ));

  it("forgets the registration on sign-out", () =>
    withWorld(({ as, store, manager, signIn }) =>
      Effect.gen(function* () {
        yield* signIn;
        yield* manager.forget("svc");
        expect((yield* store.get).servers["svc"]).toBeUndefined();
        yield* signIn;
        expect(as.registrations()).toBe(2);
      }),
    ));

  it("takes repeated 4xx answers without an error code, once the token expired, as a lost login", () =>
    withWorld(({ as, target, store, manager, signIn }) =>
      Effect.gen(function* () {
        as.setExpiresIn(1);
        yield* signIn;
        as.setExpiresIn(3600);
        yield* Effect.sleep(Duration.millis(1100));
        as.failRefresh({ status: 400, body: "<html>Bad Request</html>" });
        expect((yield* manager.accessToken("svc", target).pipe(Effect.flip))._tag).toBe("OAuthError");
        yield* Effect.sleep(Duration.millis(BACKOFF + 50));
        expect((yield* manager.accessToken("svc", target).pipe(Effect.flip))._tag).toBe("OAuthError");
        yield* Effect.sleep(Duration.millis(2 * BACKOFF + 50));
        const lost = yield* manager.accessToken("svc", target).pipe(Effect.flip);
        expect(lost).toMatchObject({ _tag: "NeedsLogin" });
        expect(lost.message).toMatch(/3 times/);
        expect(yield* manager.hasTokens("svc")).toBe(false);
        expect((yield* store.get).servers["svc"]?.client?.clientId).toBe("client-1");
      }),
    ));

  it("never gives up a login over 429s, however long they go on", () =>
    withWorld(({ as, target, manager, signIn }) =>
      Effect.gen(function* () {
        as.setExpiresIn(1);
        yield* signIn;
        as.setExpiresIn(3600);
        yield* Effect.sleep(Duration.millis(1100));
        as.failRefresh({ status: 429, body: "" });
        for (let i = 0; i < 3; i++) {
          expect((yield* manager.accessToken("svc", target).pipe(Effect.flip))._tag).toBe("OAuthError");
          yield* Effect.sleep(Duration.millis(BACKOFF * 2 ** i + 50));
        }
        expect(yield* manager.hasTokens("svc")).toBe(true);
        expect(as.refreshes()).toBe(3);
      }),
    ));

  it("keeps sending a still-valid token when a refresh ahead of expiry fails, refreshing once for everyone", () =>
    withWorld(({ as, target, manager, signIn }) =>
      Effect.gen(function* () {
        as.setExpiresIn(2);
        const token = yield* signIn;
        as.setExpiresIn(3600);
        // Past the midpoint of its two seconds: due for a refresh, still accepted.
        yield* Effect.sleep(Duration.millis(1100));
        as.failRefresh({ status: 503, body: "" });
        const tokens = yield* Effect.all(
          Array.from({ length: 5 }, () => manager.accessToken("svc", target)),
          { concurrency: 5 },
        );
        expect(tokens).toEqual(Array.from({ length: 5 }, () => token));
        expect(as.refreshes()).toBe(1);

        // Expired, and the authorization server still failing: the request fails, the login stays.
        yield* Effect.sleep(Duration.millis(1000));
        expect((yield* manager.accessToken("svc", target).pipe(Effect.flip))._tag).toBe("OAuthError");
        expect(yield* manager.hasTokens("svc")).toBe(true);

        as.failRefresh(null);
        yield* Effect.sleep(Duration.millis(2 * BACKOFF + 50));
        const next = yield* manager.accessToken("svc", target);
        expect(next).not.toBe(token);
        expect(as.isValid(next)).toBe(true);
      }),
    ));

  it("finishes a refresh even when the request that started it goes away", () =>
    withWorld(({ as, target, manager, signIn }) =>
      Effect.gen(function* () {
        const token = yield* signIn;
        // The authorization server rotates the refresh token, then answers slowly.
        as.delayRefresh(400);
        const request = yield* manager.afterRejection("svc", target, token).pipe(Effect.forkChild);
        yield* Effect.sleep(Duration.millis(100));
        yield* Fiber.interrupt(request);
        yield* Effect.sleep(Duration.millis(600));
        as.delayRefresh(0);
        const after = yield* manager.accessToken("svc", target);
        expect(after).not.toBe(token);
        expect(as.isValid(after)).toBe(true);
        expect(as.refreshes()).toBe(1);
      }),
    ));

  it("sends a login only to the server URL it was issued for", () =>
    withWorld(({ target, store, manager, signIn }) =>
      Effect.gen(function* () {
        yield* signIn;
        expect(yield* manager.hasTokens("svc", target)).toBe(true);
        expect(yield* manager.hasTokens("svc", "https://elsewhere.example/mcp")).toBe(false);
        const moved = yield* manager.accessToken("svc", "https://elsewhere.example/mcp").pipe(Effect.flip);
        expect(moved).toMatchObject({ _tag: "NeedsLogin" });
        expect(moved.message).toMatch(/sign in again/);
        // A container on this machine takes the server's login whatever its port…
        expect(yield* manager.accessToken("svc", null)).toMatch(/^at-/);
        // …but never a login for another machine, as when a remote definition became a container.
        yield* store.update((s) => {
          const e = s.servers["svc"];
          return [undefined, e?.endpoints === undefined ? s : { ...s, servers: { ...s.servers, svc: { ...e, endpoints: { ...e.endpoints, resource: "https://remote.example/mcp" } } } }];
        });
        expect(yield* manager.hasTokens("svc", null)).toBe(false);
        expect((yield* manager.accessToken("svc", null).pipe(Effect.flip))._tag).toBe("NeedsLogin");
      }),
    ));

  it("reports how a sign-in is going by its state", () =>
    withWorld(({ as, target, manager, definition }) =>
      Effect.gen(function* () {
        const url = yield* manager.start(definition, target, null);
        const state = new URL(url).searchParams.get("state") ?? "";
        expect(yield* manager.loginStatus(state)).toEqual({ status: "pending", server: "svc", detail: null });
        expect(yield* manager.loginStatus("forged")).toEqual({ status: "unknown", server: null, detail: null });
        yield* manager.finish({ code: as.approve(url), state });
        expect(yield* manager.loginStatus(state)).toEqual({ status: "done", server: "svc", detail: null });

        const refused = yield* manager.start(definition, target, null);
        const refusedState = new URL(refused).searchParams.get("state") ?? "";
        yield* manager.finish({ state: refusedState, error: "access_denied" }).pipe(Effect.flip);
        expect(yield* manager.loginStatus(refusedState)).toMatchObject({ status: "failed", server: "svc", detail: expect.stringMatching(/access_denied/) });
      }),
    ));
});
