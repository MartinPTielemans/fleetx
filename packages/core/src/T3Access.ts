/**
 * Reading T3's own view of its providers: whether each one is logged in,
 * ready, or failing, the way T3's settings screen shows it. T3 tracks this
 * for every driver it has (Claude, Codex, Cursor, OpenCode, Grok, Pi, …), so
 * T3 Fleet asks T3 instead of guessing per CLI.
 *
 * T3 serves the snapshot as `server.getConfig` over its authenticated
 * WebSocket RPC (`/ws`, scope orchestration:read). T3 Fleet holds its own
 * token for that, with that one scope and nothing else:
 *
 *   1. `t3 auth pairing create --ttl 2m --label t3-fleet --json`, T3's own
 *      command for headless clients, issues a one-time pairing credential
 *   2. POST /oauth/token exchanges it for a bearer token, asking for
 *      scope=orchestration:read only (T3 grants a subset of the pairing's
 *      scopes on request); T3 lists it as a client labelled "T3 Fleet"
 *   3. the token goes to ~/.config/t3-fleet/t3-access.json, mode 600; it lasts
 *      T3's default 30 days
 *
 * That is `t3-fleet t3 connect`, run as a fix (`t3-access`), never by the
 * probe. The probe only reads: it trades the token for a five-minute
 * WebSocket ticket (POST /api/auth/websocket-ticket), calls server.getConfig
 * once, and closes. getConfig returns T3's cached provider checks; it starts
 * no provider and no usage query.
 *
 * The desktop app has no `t3` on disk; its server is the app's bundled
 * bin.mjs run as Node by the app binary, and the same CLI is reached that way.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import type { ProviderAuth } from "./Api.ts";
import { exec } from "./Exec.ts";
import { ForwardCompatibleArray } from "./vendor/t3/baseSchemas.ts";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "./vendor/t3/environment.ts";
import { ServerProvider } from "./vendor/t3/server.ts";
import { configDir, stateDir } from "./Names.ts";

export const t3AccessPath = (home: string) => `${configDir(home)}/t3-access.json`;

/** When `t3-fleet t3 connect` last tried to mint a token (ms since the epoch), so sync renews at most once a day. */
export const t3AccessAttemptPath = (home: string) => `${stateDir(home)}/t3-access-attempt`;

/** A token closer than this to expiring is renewed; a new one must outlive it to count as renewed. */
export const RENEW_WITHIN_MS = 3 * 86_400_000;

export const T3AccessFile = Schema.Struct({
  origin: Schema.String,
  token: Schema.String,
  /** ms since the epoch. */
  expiresAt: Schema.Number,
});
export type T3AccessFile = typeof T3AccessFile.Type;

/** The fields of T3's provider snapshot T3 Fleet reads; T3 adds others freely. */
export const ProviderSnapshot = Schema.Struct(
  Struct.pick(ServerProvider.fields, [
    "instanceId",
    "driver",
    "enabled",
    "installed",
    "version",
    "status",
    "auth",
    "checkedAt",
    "message",
  ]),
);
export type ProviderSnapshot = typeof ProviderSnapshot.Type;

const T3Error = Schema.Struct({ _tag: Schema.String, message: Schema.optionalKey(Schema.String) });

/** server.getConfig, reduced to the providers; the rest of T3's config is ignored. */
export class T3ConfigRpcs extends RpcGroup.make(
  Rpc.make("server.getConfig", {
    payload: Schema.Struct({}),
    success: Schema.Struct({ providers: ForwardCompatibleArray(ProviderSnapshot) }),
    error: T3Error,
  }),
) {}

/** A provider snapshot as T3 Fleet reports it. The account's email is left out: observations are published. */
export const fromSnapshot = (p: ProviderSnapshot): ProviderAuth => ({
  instanceId: String(p.instanceId),
  driver: String(p.driver),
  enabled: p.enabled,
  auth: p.auth.status,
  method: p.auth.type ?? null,
  label: p.auth.label ?? null,
  status: p.status,
  detail:
    p.message ??
    (p.installed ? (p.version === null ? "installed" : `version ${p.version}`) : "not installed"),
  checkedAt: Number.isNaN(Date.parse(p.checkedAt)) ? null : Date.parse(p.checkedAt),
  source: "t3",
});

export type SnapshotResult =
  | { readonly _tag: "ok"; readonly providers: ReadonlyArray<ProviderAuth> }
  | { readonly _tag: "rejected" }
  | { readonly _tag: "failed"; readonly detail: string };

const wsUrl = (origin: string, ticket: string) => {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
};

const Ticket = Schema.Struct({ ticket: Schema.String });

/** T3's provider snapshot, read with T3 Fleet's token. Never fails. */
export const readProviderSnapshot = (origin: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(new URL("/api/auth/websocket-ticket", origin).toString()).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(Effect.timeout(Duration.seconds(5)), Effect.option);
    if (Option.isNone(response))
      return { _tag: "failed", detail: `T3 at ${origin} did not answer` } satisfies SnapshotResult;
    if (response.value.status === 401 || response.value.status === 403)
      return { _tag: "rejected" } satisfies SnapshotResult;
    const ticket = yield* response.value.text.pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Ticket))),
      Effect.option,
    );
    if (Option.isNone(ticket))
      return {
        _tag: "failed",
        detail: `T3 answered the ticket request with HTTP ${response.value.status}`,
      } satisfies SnapshotResult;
    const config = yield* Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* RpcClient.make(T3ConfigRpcs);
        return yield* rpc["server.getConfig"]({});
      }),
    ).pipe(
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(wsUrl(origin, ticket.value.ticket), {
              openTimeout: Duration.seconds(5),
            }),
          ),
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
      Effect.timeout(Duration.seconds(10)),
      Effect.result,
    );
    if (config._tag === "Failure")
      return {
        _tag: "failed",
        detail: `server.getConfig failed: ${describe(config.failure)}`,
      } satisfies SnapshotResult;
    return {
      _tag: "ok",
      providers: config.success.providers.map(fromSnapshot),
    } satisfies SnapshotResult;
  });

const describe = (error: unknown) => {
  const tag = (error as { _tag?: unknown })._tag;
  const message = (error as { message?: unknown }).message;
  return [typeof tag === "string" ? tag : "error", typeof message === "string" ? message : ""]
    .filter((s) => s !== "")
    .join(": ")
    .slice(0, 200);
};

/** T3 Fleet's T3 token on this machine, if any. */
export const readAccess = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(t3AccessPath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<T3AccessFile>();
    return yield* Schema.decodeEffect(Schema.fromJsonString(T3AccessFile))(text.value).pipe(
      Effect.option,
    );
  });

// ---- the T3 CLI, for minting --------------------------------------------------

/**
 * How to run T3's CLI on this machine, from the running server's command
 * line: a CLI install runs ~/.t3/runtime/versions/<v>/t3; the desktop app
 * runs its bundled server with the app binary as Node.
 */
export const t3CliFromCommandLine = (
  commandLine: string,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
} | null => {
  const cli = /(\S*\/versions\/[0-9][^/\s]*\/t3)\b/.exec(commandLine);
  if (cli?.[1] !== undefined) return { command: cli[1], args: [], env: {} };
  const desktop =
    /^(\/.+?)(?: --require .+?)? (\/.+?\/app\.asar\/apps\/server\/dist\/bin\.mjs)\b/.exec(
      commandLine.trim(),
    );
  if (desktop?.[1] !== undefined && desktop[2] !== undefined)
    return { command: desktop[1], args: [desktop[2]], env: { ELECTRON_RUN_AS_NODE: "1" } };
  return null;
};

const Pairing = Schema.Struct({ credential: Schema.String });
const TokenResult = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
});

export class T3AccessError extends Schema.TaggedError<T3AccessError>()("T3AccessError", {
  message: Schema.String,
}) {}

/** Mints T3 Fleet's read-only token for the T3 server at `origin` and writes it. */
export const mintAccess = (input: {
  readonly home: string;
  readonly origin: string;
  readonly cli: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Record<string, string>;
  };
  readonly now: number;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Every attempt counts, failed ones too: each pairing adds a client in T3.
    yield* fs.makeDirectory(stateDir(input.home), { recursive: true }).pipe(Effect.ignore);
    yield* fs
      .writeFileString(t3AccessAttemptPath(input.home), `${input.now}\n`)
      .pipe(Effect.ignore);
    const pairing = yield* exec({
      command: input.cli.command,
      args: [
        ...input.cli.args,
        "auth",
        "pairing",
        "create",
        "--ttl",
        "2m",
        "--label",
        "T3 Fleet",
        "--json",
      ],
      env: { ...process.env, ...input.cli.env },
      timeout: Duration.seconds(60),
    });
    const credential = yield* Schema.decodeEffect(Schema.fromJsonString(Pairing))(
      pairing.stdout.trim(),
    ).pipe(
      Effect.mapError(
        () =>
          new T3AccessError({
            message: `t3 auth pairing create failed: ${(pairing.stderr || pairing.stdout).trim().split("\n").at(-1) ?? `exit ${pairing.code}`}`,
          }),
      ),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post(new URL("/oauth/token", input.origin).toString()).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: credential.credential,
            subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
            requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
            scope: "orchestration:read",
            client_label: "T3 Fleet",
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new T3AccessError({ message: `T3 at ${input.origin} did not answer` }),
        ),
      );
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const token = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResult))(body).pipe(
      Effect.mapError(
        () =>
          new T3AccessError({ message: `T3 refused the token exchange (HTTP ${response.status})` }),
      ),
    );
    if (token.scope !== "orchestration:read")
      return yield* new T3AccessError({
        message: `T3 granted "${token.scope}", not orchestration:read alone; not keeping it`,
      });
    const access: T3AccessFile = {
      origin: input.origin,
      token: token.access_token,
      expiresAt: input.now + token.expires_in * 1000,
    };
    const file = t3AccessPath(input.home);
    yield* fs.makeDirectory(configDir(input.home), { recursive: true }).pipe(Effect.ignore);
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(T3AccessFile))(access);
    yield* fs.writeFileString(`${file}.tmp`, `${text}\n`, { mode: 0o600 });
    yield* fs.chmod(`${file}.tmp`, 0o600);
    yield* fs.rename(`${file}.tmp`, file);
    // Kept, since it works, but not a renewal: it would be due again at once.
    if (token.expires_in * 1000 <= RENEW_WITHIN_MS) {
      return yield* new T3AccessError({
        message: `T3 issued a token valid for only ${Math.round(token.expires_in / 3600)} hours; T3 Fleet renews tokens three days before they expire, at most once a day`,
      });
    }
    return access;
  });
