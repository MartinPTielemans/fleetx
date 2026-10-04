/**
 * What the hub must keep across restarts and must not leak: OAuth client
 * registrations and tokens per server, and the digests of client tokens.
 *
 * One JSON document, encrypted with age to the relay node's own key
 * (~/.config/t3-fleet/age-key.txt) and written atomically with mode 600 to
 * ~/.local/state/t3-fleet/hub/tokens.age. It never enters the config repo and
 * no other node can read it. Writes are serialized; reads come from memory.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { identityToRecipient } from "age-encryption";

import { decryptWith, encryptFor } from "../Secrets.ts";
import { stateDir } from "../Names.ts";

export const OAuthClient = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.NullOr(Schema.String),
  /** How the token endpoint wants the client to authenticate. */
  authMethod: Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
  /** The exact redirect URI registered; a new relay URL means a new registration. */
  redirectUri: Schema.String,
  issuer: Schema.String,
  /** True when registered dynamically (RFC 7591), false for a static client. */
  registered: Schema.Boolean,
});
export type OAuthClient = typeof OAuthClient.Type;

export const OAuthTokens = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  /** Epoch milliseconds; null when the server did not say. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** Epoch milliseconds when issued, for tokens that live less than the refresh margin. */
  issuedAt: Schema.optionalKey(Schema.Number),
  scope: Schema.NullOr(Schema.String),
});
export type OAuthTokens = typeof OAuthTokens.Type;

export const OAuthEndpoints = Schema.Struct({
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  /** The RFC 8707 resource the tokens are for. */
  resource: Schema.String,
});
export type OAuthEndpoints = typeof OAuthEndpoints.Type;

const StoredServer = Schema.Struct({
  client: Schema.optionalKey(OAuthClient),
  endpoints: Schema.optionalKey(OAuthEndpoints),
  tokens: Schema.optionalKey(OAuthTokens),
});
export type StoredServer = typeof StoredServer.Type;

export const StoredClientToken = Schema.Struct({
  /** SHA-256 of the token, hex. */
  hash: Schema.String,
  /** Servers the token may reach; null for all. */
  servers: Schema.NullOr(Schema.Array(Schema.String)),
  createdAt: Schema.Number,
});
export type StoredClientToken = typeof StoredClientToken.Type;

const Store = Schema.Struct({
  servers: Schema.Record(Schema.String, StoredServer),
  clients: Schema.Record(Schema.String, StoredClientToken),
});
export type Store = typeof Store.Type;

const empty: Store = { servers: {}, clients: {} };

const decodeStore = Schema.decodeUnknownOption(Schema.fromJsonString(Store));
const encodeStore = Schema.encodeUnknownEffect(Schema.fromJsonString(Store));

export interface TokenStore {
  readonly get: Effect.Effect<Store>;
  /** Change the store; the new document is encrypted and written before this returns. */
  readonly update: <A>(f: (store: Store) => readonly [A, Store]) => Effect.Effect<A>;
}

export const tokenStorePath = (home: string) => `${stateDir(home)}/hub/tokens.age`;

export const makeTokenStore = (options: { readonly file: string; readonly identity: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const recipient = yield* Effect.promise(() => identityToRecipient(options.identity));
    let current = empty;
    const armored = yield* fs.readFileString(options.file).pipe(Effect.option);
    if (Option.isSome(armored)) {
      const plain = yield* decryptWith(options.identity, armored.value).pipe(Effect.option);
      const decoded = Option.flatMap(plain, decodeStore);
      if (Option.isSome(decoded)) current = decoded.value;
      else yield* Effect.logWarning(`hub: ${options.file} cannot be read with this node's key; starting with no stored logins`);
    }
    const lock = yield* Semaphore.make(1);

    const write = (store: Store) =>
      Effect.gen(function* () {
        const text = yield* encodeStore(store);
        const sealed = yield* encryptFor([recipient], text);
        yield* fs.makeDirectory(path.dirname(options.file), { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
        const temp = `${options.file}.tmp`;
        yield* fs.writeFileString(temp, sealed, { mode: 0o600 });
        yield* fs.chmod(temp, 0o600);
        yield* fs.rename(temp, options.file);
      });

    const store: TokenStore = {
      get: Effect.sync(() => current),
      update: (f) =>
        Semaphore.withPermit(
          lock,
          Effect.gen(function* () {
            const [result, next] = f(current);
            yield* write(next).pipe(Effect.tapError((e) => Effect.logError(`hub: writing ${options.file} failed: ${String(e)}`)), Effect.ignore);
            current = next;
            return result;
          }),
        ),
    };
    return store;
  });

/** Replace one server's entry, or remove it with null. */
export const withServer = (store: Store, name: string, entry: StoredServer | null): Store => {
  const servers = { ...store.servers };
  if (entry === null) delete servers[name];
  else servers[name] = entry;
  return { ...store, servers };
};
