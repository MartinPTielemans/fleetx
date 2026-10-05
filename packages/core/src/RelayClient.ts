/**
 * Talking to the relay, when the fleet has one (`[relay] url`). Every call is
 * best effort: a missing or unreachable relay leaves git as the only path,
 * which is slower but complete.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { Config } from "./Config.ts";
import { localSecretsPath } from "./Secrets.ts";
import { NodeState } from "./State.ts";

export const RELAY_TOKEN = "T3_FLEET_RELAY_TOKEN";

/** This node's installed secrets, by name; empty when it has none. */
export const localSecrets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(localSecretsPath(process.env["HOME"] ?? ""))
    .pipe(Effect.orElseSucceed(() => ""));
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] !== undefined)
      values.set(m[1], (m[2] ?? "").replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1"));
  }
  return values as ReadonlyMap<string, string>;
});

/** A variable from this node's installed secrets, or the environment. */
export const secretVar = (name: string) =>
  localSecrets.pipe(Effect.map((values) => values.get(name) ?? process.env[name] ?? ""));

/**
 * `text` with every value of `secrets` long enough to mean something put out
 * of sight: what leaves the node (a fix's output, a published fix) must not
 * carry one.
 */
export const redactSecrets = (text: string, secrets: ReadonlyMap<string, string>) => {
  let out = text;
  for (const value of secrets.values()) if (value.length >= 6) out = out.replaceAll(value, "•••");
  return out;
};

export const relayUrlOf = (config: Config) =>
  config.settings.relay?.url?.replace(/\/+$/, "") ?? null;

const encodeState = Schema.encodeEffect(Schema.fromJsonString(NodeState));

/** Hand a node's state to the relay. */
export const reportToRelay = (config: Config, state: NodeState) =>
  Effect.gen(function* () {
    const url = relayUrlOf(config);
    if (url === null) return false;
    const token = yield* secretVar(RELAY_TOKEN);
    if (token === "") return false;
    const client = yield* HttpClient.HttpClient;
    const body = yield* encodeState(state);
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${url}/report`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      )
      .pipe(Effect.timeout(Duration.seconds(10)), Effect.option);
    return Option.match(response, { onNone: () => false, onSome: (r) => r.status === 204 });
  }).pipe(Effect.orElseSucceed(() => false));

const decodeFixEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ node: Schema.String, request: Schema.String })),
);

/**
 * Follow the relay's event stream and call `onPull` whenever the branch
 * moves (or was moved while this node was away), and `onFix` with each fix
 * request's node and id (FixRequest.ts), on a fiber of its own so a running
 * fix holds up neither. Reconnects forever, resuming after the last event it
 * saw. `url` overrides `[relay] url` (the relay node follows itself on
 * loopback).
 */
export const listen = <E, R, R2 = never>(
  config: Config,
  onPull: (rev: string) => Effect.Effect<void, E, R>,
  log: (line: string) => Effect.Effect<void>,
  onFix?: (node: string, request: string) => Effect.Effect<void, never, R2>,
  url_?: string,
) =>
  Effect.gen(function* () {
    const url = url_ ?? relayUrlOf(config);
    if (url === null) return yield* Effect.fail("no [relay] url in t3-fleet.toml");
    const token = yield* secretVar(RELAY_TOKEN);
    if (token === "") return yield* Effect.fail(`no ${RELAY_TOKEN} in this node's secrets`);
    const client = yield* HttpClient.HttpClient;
    let lastId = 0;
    const once = Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.get(`${url}/events?since=${lastId}`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.setHeader("accept", "text/event-stream"),
        ),
      );
      if (response.status !== 200) return yield* Effect.fail(`relay answered ${response.status}`);
      yield* log(`connected to ${url}`);
      let buffer = "";
      yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            buffer += chunk;
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const id = /^id: (\d+)$/m.exec(frame)?.[1];
              const type = /^event: (\w+)$/m.exec(frame)?.[1];
              const rev = /"rev":"([0-9a-f]+)"/.exec(frame)?.[1] ?? "";
              if (id !== undefined) lastId = Number(id);
              if (type === "pull") yield* onPull(rev);
              if (type === "fix" && onFix !== undefined) {
                const data = decodeFixEvent(/^data: (.*)$/m.exec(frame)?.[1] ?? "");
                if (Option.isSome(data))
                  yield* onFix(data.value.node, data.value.request).pipe(Effect.forkDetach);
              }
            }
          }),
        ),
      );
      return yield* Effect.fail("relay closed the stream");
    });
    return yield* once.pipe(
      Effect.tapError((e) => log(`relay: ${String(e)}; reconnecting`)),
      Effect.retry(Schedule.spaced(Duration.seconds(15))),
    );
  });

/** Every node's latest state as the relay has it; null when there is no relay or it does not answer. */
export const fleetFromRelay = (config: Config) =>
  Effect.gen(function* () {
    const url = relayUrlOf(config);
    if (url === null) return null;
    const token = yield* secretVar(RELAY_TOKEN);
    if (token === "") return null;
    const client = yield* HttpClient.HttpClient;
    const text = yield* client
      .execute(HttpClientRequest.get(`${url}/fleet`).pipe(HttpClientRequest.bearerToken(token)))
      .pipe(
        Effect.flatMap((r) =>
          r.status === 200 ? r.text.pipe(Effect.asSome) : Effect.succeed(Option.none<string>()),
        ),
        Effect.timeout(Duration.seconds(8)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    if (Option.isNone(text)) return null;
    return Option.getOrNull(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(NodeState)))(text.value).pipe(
        Effect.option,
      ),
    );
  }).pipe(Effect.orElseSucceed(() => null));
