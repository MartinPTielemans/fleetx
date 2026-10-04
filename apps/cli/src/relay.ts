/**
 * t3-fleet relay serve   run the relay (on the node with the relay role)
 * t3-fleet listen        follow the relay and sync as soon as the branch moves
 */
// The HTTP server itself has no Effect equivalent; T3 Code builds its server the same way.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { loadConfig, type Config } from "@t3-fleet/core/Config";
import { decodeModelsSettings, upstreamBases, upstreamsOf } from "@t3-fleet/core/models/Recipes";
import { git, out } from "@t3-fleet/core/Git";
import { relayLayer } from "@t3-fleet/core/Relay";
import { listen, RELAY_TOKEN, secretVar } from "@t3-fleet/core/RelayClient";
import { ensureIdentity } from "@t3-fleet/core/Secrets";
import { syncRun } from "@t3-fleet/core/Sync";

import packageJson from "../package.json" with { type: "json" };

import { reportUserErrors, untilNewBuild } from "./shared.ts";

/** Every upstream base some node's [models] declares: where /egress may forward. */
const egressBasesOf = (config: Config) => [
  ...new Set(
    config.nodes.flatMap((n) =>
      upstreamBases(upstreamsOf(decodeModelsSettings(n.settings.table["models"]))),
    ),
  ),
];

const serve = Command.make("serve").pipe(
  Command.withDescription(
    "Run the relay on 127.0.0.1:[relay] port. Publish it to the tailnet, never the internet.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const self = config.nodes.find((n) => n.name === config.self);
      if (!self?.roles.includes("relay"))
        return yield* Effect.fail(`${config.self} does not have the relay role`);
      const token = yield* secretVar(RELAY_TOKEN);
      if (token === "")
        return yield* Effect.fail(
          `no ${RELAY_TOKEN} in this node's secrets (t3-fleet secrets set ${RELAY_TOKEN}=… on an authority)`,
        );
      const port = config.settings.relay?.port ?? 8399;
      const mcp = (self.settings.table["mcp"] ?? {}) as {
        ports?: Record<string, number>;
        hub?: boolean;
      };
      const { identity } = yield* ensureIdentity;
      // Followed as sync updates the config repo; a read that fails keeps the last good set.
      let egressBases = egressBasesOf(config);
      yield* loadConfig.pipe(
        Effect.map((c) => {
          egressBases = egressBasesOf(c);
        }),
        Effect.ignore,
        Effect.repeat(Schedule.spaced(Duration.seconds(30))),
        Effect.forkDetach,
      );
      const hub = mcp.hub === true;
      yield* Console.log(
        `relay on 127.0.0.1:${port}; ${hub ? "MCP hub serving the repo's hosted servers" : `MCP gateway for ${Object.keys(mcp.ports ?? {}).join(", ") || "no servers"}`}`,
      );
      const routes = relayLayer({
        token,
        repo: config.repo,
        branch: config.branch,
        hub: {
          repo: config.repo,
          home: process.env["HOME"] ?? "",
          enabled: hub,
          ports: mcp.ports ?? {},
          relayUrl: config.settings.relay?.url ?? null,
          identity,
          version: packageJson.version,
        },
        egressBases: () => egressBases,
      });
      return yield* untilNewBuild(
        Layer.launch(
          HttpRouter.serve(routes).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port }),
            ),
          ),
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
  Command.withDescription(
    "Follow the relay; sync as soon as the config branch moves. Runs until stopped.",
  ),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const log = (line: string) =>
        DateTime.now.pipe(
          Effect.flatMap((now) => Console.log(`${DateTime.formatIso(now)} ${line}`)),
        );
      return yield* untilNewBuild(
        listen(
          config,
          (rev) =>
            Effect.gen(function* () {
              const head = out(yield* git(config.repo, ["rev-parse", "--short", "HEAD"]));
              if (rev !== "" && head.startsWith(rev)) return;
              yield* log(`branch moved to ${rev}; syncing`);
              // A sync already running may have started before the branch moved: wait for it, then sync again.
              const result = yield* syncRun(config, { apply: true }).pipe(
                Effect.repeat({
                  while: (r) => r.state === null,
                  schedule: Schedule.spaced(Duration.seconds(20)),
                  times: 45,
                }),
                Effect.result,
              );
              yield* log(
                result._tag === "Success"
                  ? (result.success.state?.message ?? (result.success.lines.join("; ") || "done"))
                  : `sync failed: ${String(result.failure)}`,
              );
            }),
          log,
        ),
      );
    }).pipe(reportUserErrors),
  ),
);
