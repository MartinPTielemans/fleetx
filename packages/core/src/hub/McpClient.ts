/**
 * A one-shot MCP client, for `t3-fleet mcp tools` and `t3-fleet mcp call`: an
 * agent whose session cannot reload its MCP registrations still reaches every
 * server this node is registered with, the same way its clients do (the hub's
 * gateway with this node's token, or a direct server with its own).
 *
 * One session per command: initialize, the request, then the session is
 * deleted again. Streamable HTTP only; stdio servers run on this machine and
 * are reached through the agent CLIs.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { Definition, expandEmbedded, resolveEndpoint, secretRef } from "../areas/Mcp.ts";
import type { Config } from "../Config.ts";
import { secretVar } from "../RelayClient.ts";
import { messagesInBody, toJson, type JsonRpcMessage } from "./JsonRpc.ts";

const PROTOCOL = "2025-06-18";

/** How to reach a server from this node: its URL and the headers it needs, secrets filled in. */
export interface Target {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Where this node's clients reach `name`, from mcp/<name>.json and the node's [mcp] settings. */
export const targetFor = (config: Config, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs
      .readFileString(path.join(config.repo, "mcp", `${name}.json`))
      .pipe(Effect.option);
    if (Option.isNone(text)) return yield* Effect.fail(`no MCP server ${name} (mcp/${name}.json)`);
    const def = Schema.decodeOption(Schema.fromJsonString(Definition))(text.value);
    if (Option.isNone(def)) return yield* Effect.fail(`mcp/${name}.json is not a valid definition`);
    const self = config.nodes.find((n) => n.name === config.self);
    const desired = (self?.settings.table["mcp"] ?? {}) as Parameters<typeof resolveEndpoint>[2];
    const { endpoint, problem } = resolveEndpoint(
      name,
      def.value,
      desired,
      process.env["HOME"] ?? "",
    );
    if (endpoint === null) return yield* Effect.fail(`${name}: ${problem}`);
    if (endpoint.type === "stdio")
      return yield* Effect.fail(
        `${name} is a stdio server; it runs inside the agent CLIs, not over HTTP`,
      );
    if (endpoint.transport === "sse")
      return yield* Effect.fail(`${name} speaks the old SSE transport, which this client does not`);
    const values = new Map<string, string>();
    const value = (n: string) => values.get(n);
    const wanted = [
      ...(endpoint.tokenEnv === null ? [] : [endpoint.tokenEnv]),
      ...Object.values(endpoint.headers ?? {}).flatMap((v) => {
        const ref = secretRef(v);
        return ref === null ? [] : [ref];
      }),
      ...[...endpoint.url.matchAll(/\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/g)].map(
        (m) => m[1] ?? m[2] ?? "",
      ),
    ];
    for (const n of wanted) values.set(n, yield* secretVar(n));
    const headers: Record<string, string> = {};
    if (endpoint.tokenEnv !== null) {
      const token = value(endpoint.tokenEnv) ?? "";
      if (token === "")
        return yield* Effect.fail(
          `${name} needs ${endpoint.tokenEnv}, which this machine's secrets do not have`,
        );
      headers["authorization"] = `Bearer ${token}`;
    }
    for (const [k, v] of Object.entries(endpoint.headers ?? {})) {
      const ref = secretRef(v);
      headers[k] = ref === null ? v : (value(ref) ?? "");
    }
    return { url: expandEmbedded(endpoint.url, value), headers } satisfies Target;
  });

/**
 * Send `method` with `params` in a fresh session and return the result. A
 * JSON-RPC error, an HTTP error and a timeout are failures, as sentences.
 */
export const request = (
  target: Target,
  method: string,
  params: Readonly<Record<string, unknown>>,
  timeout = Duration.seconds(120),
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let session: string | undefined;
    const post = (body: unknown) =>
      Effect.gen(function* () {
        const response = yield* client
          .execute(
            HttpClientRequest.post(target.url).pipe(
              HttpClientRequest.setHeaders({
                ...target.headers,
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": PROTOCOL,
                ...(session === undefined ? {} : { "mcp-session-id": session }),
              }),
              HttpClientRequest.bodyText(toJson(body), "application/json"),
            ),
          )
          .pipe(Effect.mapError(() => `${target.url} does not answer`));
        session = response.headers["mcp-session-id"] ?? session;
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        if (response.status === 202) return [] as ReadonlyArray<JsonRpcMessage>;
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail(
            `HTTP ${response.status}${text.trim() === "" ? "" : `: ${text.trim().slice(0, 300)}`}`,
          );
        return messagesInBody(response.headers["content-type"], text);
      });
    const answer = (messages: ReadonlyArray<JsonRpcMessage>, id: number) =>
      Effect.gen(function* () {
        const reply = messages.find((m) => m.id === id);
        if (reply === undefined) return yield* Effect.fail(`no answer to ${method}`);
        if (reply.error !== undefined)
          return yield* Effect.fail(`${method}: ${reply.error.message}`);
        return reply.result;
      });

    const run = Effect.gen(function* () {
      yield* answer(
        yield* post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: "t3-fleet", version: "1" },
          },
        }),
        1,
      );
      yield* post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return yield* answer(yield* post({ jsonrpc: "2.0", id: 2, method, params }), 2);
    });

    const close = Effect.suspend(() =>
      session === undefined
        ? Effect.void
        : client
            .execute(
              HttpClientRequest.delete(target.url).pipe(
                HttpClientRequest.setHeaders({ ...target.headers, "mcp-session-id": session }),
              ),
            )
            .pipe(
              Effect.flatMap((r) => r.text),
              Effect.timeout(Duration.seconds(5)),
              Effect.ignore,
            ),
    );

    return yield* run.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(`no answer to ${method} within ${Duration.format(timeout)}`),
      }),
      Effect.ensuring(close),
    );
  });
