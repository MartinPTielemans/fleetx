/**
 * t3-fleet models serve            run the model proxy on 127.0.0.1:8398 (the models area installs it as a service)
 * t3-fleet models stats            this node's proxy traffic
 * t3-fleet models route <instance> point T3's provider instance at its launcher (the fix for models-not-routed)
 */
// The HTTP server itself has no Effect equivalent; T3 Code builds its server the same way.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import type { ModelProxyStats, ModelWindow } from "@t3-fleet/core/Api";
import { loadConfig } from "@t3-fleet/core/Config";
import { fetchStats, MODELS_PORT, modelProxyLayer } from "@t3-fleet/core/models/Proxy";
import { decodeModelsSettings, launcherPath, upstreamsOf, type ModelsSettings } from "@t3-fleet/core/models/Recipes";
import { routeProvider } from "@t3-fleet/core/models/Route";
import { RELAY_TOKEN, secretVar } from "@t3-fleet/core/RelayClient";
import { providerPlans, readT3Settings } from "@t3-fleet/core/T3Settings";

import packageJson from "../package.json" with { type: "json" };
import { encodeJson, reportUserErrors, untilNewBuild } from "./shared.ts";

/** This node's [models] settings; empty when T3 Fleet is not set up here (the proxy still serves). */
const ownSettings = loadConfig.pipe(
  Effect.map((config) => {
    const self = config.nodes.find((n) => n.name === config.self);
    return { models: decodeModelsSettings(self?.settings.table["models"]), relayUrl: config.settings.relay?.url ?? null };
  }),
  Effect.orElseSucceed(() => ({ models: {} as ModelsSettings, relayUrl: null as string | null })),
);

const serve = Command.make("serve", {
  egress: Flag.Literals("egress", ["direct", "relay"]).pipe(
    Flag.withDescription("Send traffic straight to the providers, or through the relay. Defaults to [models] egress."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Run the model proxy on 127.0.0.1:8398. A pass-through: clients keep their own credentials."),
  Command.withHandler(({ egress: flag }) =>
    Effect.gen(function* () {
      const { models, relayUrl } = yield* ownSettings;
      const egress = Option.getOrElse(flag, () => models.egress ?? "direct");
      let relay: { url: string; token: string } | undefined;
      if (egress === "relay") {
        if (relayUrl === null) return yield* Effect.fail("egress = relay, but fleetx.toml has no [relay] url");
        const token = yield* secretVar(RELAY_TOKEN);
        if (token === "") return yield* Effect.fail(`egress = relay needs ${RELAY_TOKEN} in this node's secrets`);
        relay = { url: relayUrl, token };
      }
      const home = process.env["HOME"] ?? "";
      yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeDirectory(`${home}/.local/state/t3-fleet`, { recursive: true })), Effect.ignore);
      // Upstreams follow the config repo as sync updates it, without a restart.
      let upstreams = upstreamsOf(models);
      yield* ownSettings.pipe(
        Effect.map((s) => {
          upstreams = upstreamsOf(s.models);
        }),
        Effect.repeat(Schedule.spaced(Duration.seconds(30))),
        Effect.forkDetach,
      );
      yield* Console.log(`model proxy on 127.0.0.1:${MODELS_PORT} for ${Object.keys(upstreams).join(", ")}, egress ${egress}${relay === undefined ? "" : ` via ${relay.url}`}`);
      const routes = modelProxyLayer({ home, version: packageJson.version, egress, upstreams: () => upstreams, ...(relay === undefined ? {} : { relay }) });
      return yield* untilNewBuild(
        Layer.launch(
          HttpRouter.serve(routes).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: MODELS_PORT })),
          ),
        ),
      );
    }).pipe(reportUserErrors),
  ),
);

const ms = (n: number | null) => (n === null ? "-" : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);

const windowLine = (label: string, w: ModelWindow) => {
  const failures = Object.entries(w.failures).map(([k, v]) => `${k} ${v}`).join(", ");
  return `    ${label.padEnd(4)} ${String(w.requests).padStart(6)} req  ${String(w.retried).padStart(4)} retried  ${String(w.failed).padStart(4)} failed${
    failures === "" ? "" : ` (${failures})`
  }  ${w.fallbacks > 0 ? `${w.fallbacks} fallbacks  ` : ""}ttfb p50 ${ms(w.ttfbP50Ms)} p95 ${ms(w.ttfbP95Ms)}`;
};

export const renderModelStats = (stats: ModelProxyStats) => {
  const up = Math.round((stats.at - stats.startedAt) / 60_000);
  const lines = [`model proxy ${stats.version}  egress ${stats.egress}  up ${up < 120 ? `${up}m` : `${Math.round(up / 60)}h`}`];
  for (const u of stats.upstreams) {
    lines.push("", `  ${u.upstream}`, windowLine("5m", u.m5), windowLine("1h", u.h1), windowLine("24h", u.h24));
    if (u.lastError !== null) lines.push(`    last error ${DateTime.formatIso(DateTime.makeUnsafe(u.lastError.at))}  ${u.lastError.class}  ${u.lastError.message}`);
  }
  return lines.join("\n");
};

const stats = Command.make("stats", {
  json: Flag.Boolean("json").pipe(Flag.withDescription("Print ModelProxyStats as JSON."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("This node's model proxy traffic: 5 minutes, 1 hour, 24 hours."),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const result = yield* fetchStats().pipe(Effect.provide(FetchHttpClient.layer));
      if (result === null) return yield* Effect.fail(`no model proxy answers on 127.0.0.1:${MODELS_PORT} (t3-fleet models serve)`);
      yield* Console.log(json ? yield* encodeJson(result) : renderModelStats(result));
    }).pipe(reportUserErrors),
  ),
);

const route = Command.make("route", {
  instance: Argument.String("instance").pipe(Argument.withDescription("T3 provider instance, e.g. claudeAgent or codex.")),
  undo: Flag.Boolean("undo").pipe(Flag.withDescription("Put back the binary path T3 had before T3 Fleet first routed it."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Point a T3 provider instance at its T3 Fleet launcher. Running sessions keep their binary."),
  Command.withHandler(({ instance, undo }) =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      const settings = yield* readT3Settings(home);
      if (Option.isNone(settings) || settings.value === "invalid") return yield* Effect.fail("T3's settings.json is missing or unreadable");
      const plan = providerPlans(settings.value).find((p) => p.instanceId === instance);
      if (plan === undefined) return yield* Effect.fail(`T3 has no provider instance named ${instance}`);
      const launcher = launcherPath(home, instance);
      const fs = yield* FileSystem.FileSystem;
      if (!undo && !(yield* fs.exists(launcher))) return yield* Effect.fail(`${launcher} is not installed (t3-fleet fix --area models)`);
      const result = yield* routeProvider(home, instance, launcher, { undo }).pipe(Effect.mapError((e) => e.message));
      yield* Console.log(`T3 ${instance} binaryPath: ${result.previous ?? "(default)"} → ${result.now ?? "(default)"}`);
      yield* Console.log("T3 reloads its settings; new sessions use this, running ones keep theirs.");
    }).pipe(reportUserErrors),
  ),
);

export const modelsCommand = Command.make("models").pipe(
  Command.withDescription("The model proxy between T3's providers and the model providers."),
  Command.withSubcommands([serve, stats, route]),
);
