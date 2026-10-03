/**
 * fleetx relay serve   run the relay (on the node with the relay role)
 * fleetx listen        follow the relay and sync as soon as the branch moves
 */
// The HTTP server itself has no Effect equivalent; T3 Code builds its server the same way.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { loadConfig } from "@fleetx/core/Config";
import { git, out } from "@fleetx/core/Git";
import { relayLayer } from "@fleetx/core/Relay";
import { listen, RELAY_TOKEN, secretVar } from "@fleetx/core/RelayClient";
import { syncRun } from "@fleetx/core/Sync";

import { reportUserErrors } from "./shared.ts";

const serve = Command.make("serve").pipe(
  Command.withDescription("Run the relay on 127.0.0.1:[relay] port. Publish it to the tailnet, never the internet."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const self = config.nodes.find((n) => n.name === config.self);
      if (!self?.roles.includes("relay")) return yield* Effect.fail(`${config.self} does not have the relay role`);
      const token = yield* secretVar(RELAY_TOKEN);
      if (token === "") return yield* Effect.fail(`no ${RELAY_TOKEN} in this node's secrets (fleetx secrets set ${RELAY_TOKEN}=… on an authority)`);
      const port = config.settings.relay?.port ?? 8399;
      const mcp = (self.settings.table["mcp"] ?? {}) as { ports?: Record<string, number> };
      yield* Console.log(`relay on 127.0.0.1:${port}; MCP gateway for ${Object.keys(mcp.ports ?? {}).join(", ") || "no servers"}`);
      const routes = relayLayer({ token, repo: config.repo, branch: config.branch, mcpPorts: mcp.ports ?? {} });
      return yield* Layer.launch(
        HttpRouter.serve(routes).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port })),
        ),
      );
    }).pipe(reportUserErrors),
  ),
);

export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("The optional always-on relay."),
  Command.withSubcommands([serve]),
);

export const listenCommand = Command.make("listen").pipe(
  Command.withDescription("Follow the relay; sync as soon as the config branch moves. Runs until stopped."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const log = (line: string) => DateTime.now.pipe(Effect.flatMap((now) => Console.log(`${DateTime.formatIso(now)} ${line}`)));
      return yield* listen(
        config,
        (rev) =>
          Effect.gen(function* () {
            const head = out(yield* git(config.repo, ["rev-parse", "--short", "HEAD"]));
            if (rev !== "" && head.startsWith(rev)) return;
            yield* log(`branch moved to ${rev}; syncing`);
            const result = yield* syncRun(config, { apply: true }).pipe(Effect.result);
            yield* log(result._tag === "Success" ? (result.success.state?.message ?? "done") : `sync failed: ${String(result.failure)}`);
          }),
        log,
      );
    }).pipe(reportUserErrors),
  ),
);
