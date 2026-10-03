/**
 * Talking to the hub on the relay, for `fleetx mcp …` and the UI server:
 * the relay's URL from `[relay] url`, the relay token from this node's
 * secrets. Failures are sentences meant for the user.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { Config } from "../Config.ts";
import { RELAY_TOKEN, secretVar } from "../RelayClient.ts";

export interface HubReply {
  readonly status: number;
  readonly text: string;
}

/** One request to the relay's /hub/* routes. */
export const hubRequest = (config: Config, method: "GET" | "POST" | "DELETE", path: string, body?: string) =>
  Effect.gen(function* () {
    const url = config.settings.relay?.url?.replace(/\/+$/, "");
    if (url === undefined) return yield* Effect.fail("no [relay] url in fleetx.toml: the MCP hub runs in the relay");
    const token = yield* secretVar(RELAY_TOKEN);
    if (token === "") return yield* Effect.fail(`no ${RELAY_TOKEN} in this node's secrets`);
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(method)(`${url}${path}`).pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.setHeader("accept", "application/json"));
    if (body !== undefined) request = HttpClientRequest.bodyText(request, body, "application/json");
    const response = yield* client.execute(request).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.mapError(() => `the relay at ${url} does not answer`),
    );
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    if (response.status === 401) return yield* Effect.fail(`the relay refused ${RELAY_TOKEN}`);
    return { status: response.status, text } satisfies HubReply;
  });

/** The reply's body when it is a success, else its text as the failure. */
export const expectOk = (reply: HubReply) =>
  reply.status >= 200 && reply.status < 300 ? Effect.succeed(reply.text) : Effect.fail(reply.text.trim() === "" ? `the relay answered HTTP ${reply.status}` : reply.text.trim());

/** The secret a client token is kept under in the fleet's secrets. */
export const clientTokenEnv = (client: string) => `FLEETX_MCP_TOKEN_${client.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
