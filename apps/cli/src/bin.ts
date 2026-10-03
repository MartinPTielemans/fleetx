#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { checkNodes, type CheckReport } from "@fleetx/core/Check";
import type { Finding, Fix } from "@fleetx/core/Diagnose";
import { runFixes } from "@fleetx/core/Fix";
import { loadConfig, ProbeSettings, type Config } from "@fleetx/core/Config";
import { FleetToolkit, fleetHandlers } from "@fleetx/core/Mcp";
import { compareWithLast } from "@fleetx/core/Memory";
import { MachineObservation } from "@fleetx/core/Observation";
import { probeMachine } from "@fleetx/core/Probe";
import { renderChanges, renderFixPlan, renderFixResults, renderStatus } from "@fleetx/core/Render";

import packageJson from "../package.json" with { type: "json" };

/**
 * The bundle that gets streamed to other machines. Running from dist/bin.mjs
 * it is this file; running from source it is the last build.
 */
const ownBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const self = yield* path.fromFileUrl(new URL(import.meta.url));
  const bundle = self.endsWith(".mjs") ? self : path.join(path.dirname(self), "../dist/bin.mjs");
  return yield* fs.readFileString(bundle).pipe(
    Effect.mapError(() => `no bundle at ${bundle}; run \`pnpm build\` first`),
  );
});

const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(MachineObservation));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Internal: observe this machine and print JSON. The controller runs this over ssh. */
const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(ProbeSettings));

const probeCommand = Command.make("probe", {
  settings: Argument.String("settings").pipe(
    Argument.withDescription("Probe settings as base64url JSON."),
    Argument.withDefault(""),
  ),
}).pipe(
  Command.withDescription("Observe this machine and print the result as JSON (used over ssh)."),
  Command.withHandler(({ settings }) =>
    (settings === ""
      ? Effect.succeed({})
      : decodeSettings(Buffer.from(settings, "base64url").toString("utf8"))
    ).pipe(
      Effect.flatMap(probeMachine),
      Effect.flatMap(encodeObservation),
      Effect.flatMap((json) => Console.log(json)),
    ),
  ),
);

/**
 * Every machine is always observed, because parity findings need all of
 * them; --node only narrows what is shown and fixed.
 */
const prepare = (only: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const unknown = only.filter((name) => !config.nodes.some((n) => n.name === name));
    if (unknown.length > 0) {
      return yield* Effect.fail(`unknown machine: ${unknown.join(", ")} (known: ${config.nodes.map((n) => n.name).join(", ")})`);
    }
    const bundle = config.nodes.some((n) => n.ssh !== null) ? yield* ownBundle : "";
    const shown = (name: string) => only.length === 0 || only.includes(name);
    return { config, nodes: config.nodes, bundle, shown };
  });

/** Narrow a report to the machines asked for. */
const narrow = (report: CheckReport, shown: (name: string) => boolean): CheckReport => ({
  ...report,
  results: report.results.filter((r) => shown(r.node.name)),
  findings: report.findings.filter((f) => shown(f.node)),
});

/** A failure meant for the user rather than a bug: a sentence, or a typed config error. */
const isUserError = (error: unknown): error is string | { readonly _tag: "ConfigError"; readonly message: string } =>
  typeof error === "string" ||
  (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ConfigError");

const userMessage = (error: unknown): string =>
  typeof error === "string" ? error : isUserError(error) && typeof error !== "string" ? error.message : String(error);

/** User errors print one line and exit 1; anything else is a bug and keeps its trace. */
const reportUserErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(isUserError, (error) =>
      Console.error(`fleetx: ${userMessage(error)}`).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1;
        })),
      ),
    ),
  );

const nodeFlag = Flag.String("node").pipe(
  Flag.withDescription("Only this machine (repeatable)."),
  Flag.atLeast(0),
);

const statusCommand = Command.make("status", {
  json: Flag.Boolean("json").pipe(Flag.withDescription("Print machine-readable JSON."), Flag.withDefault(false)),
  verbose: Flag.Boolean("verbose").pipe(Flag.withDescription("Also show notes."), Flag.withDefault(false)),
  changes: Flag.Boolean("changes").pipe(
    Flag.withDescription("Only what changed since the last --changes run (for scheduled checks)."),
    Flag.withDefault(false),
  ),
  node: nodeFlag,
}).pipe(
  Command.withDescription("Check every environment: T3, the providers it launches, agent CLIs, sync."),
  Command.withHandler(({ json, verbose, changes, node }) =>
    Effect.gen(function* () {
      const { config, nodes, bundle, shown } = yield* prepare(node);
      const full = yield* checkNodes(config, bundle);
      const report = narrow(full, shown);
      if (changes) {
        const diff = yield* compareWithLast(full.findings);
        yield* Console.log(json ? yield* encodeJson(diff) : renderChanges(diff));
        return;
      }
      if (json) {
        yield* Console.log(yield* encodeJson(report));
      } else {
        yield* Console.log(renderStatus(report.results, report.findings, report.latest, { verbose, elapsedMs: report.elapsedMs }));
      }
    }).pipe(reportUserErrors),
  ),
);

const fixCommand = Command.make("fix", {
  yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDescription("Apply without asking."), Flag.withDefault(false)),
  safe: Flag.Boolean("safe").pipe(
    Flag.withDescription("Only fixes that interrupt nothing (agent CLI upgrades)."),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withAlias("n"), Flag.withDescription("Show the plan and stop."), Flag.withDefault(false)),
  node: nodeFlag,
}).pipe(
  Command.withDescription("Apply the fixes `status` suggests, after showing them."),
  Command.withHandler(({ yes, safe, dryRun, node }) =>
    Effect.gen(function* () {
      const { config, nodes, bundle, shown } = yield* prepare(node);
      const report = narrow(yield* checkNodes(config, bundle), shown);
      const fixes = report.findings.filter(
        (f): f is Finding & { readonly fix: Fix } => f.fix !== undefined && (!safe || f.fix.safe),
      );
      const skipped = report.findings.filter((f) => f.fix !== undefined && safe && !f.fix.safe);
      yield* Console.log(renderFixPlan(fixes, report.findings, skipped));
      if (fixes.length === 0 || dryRun) return;
      if (!yes) {
        if (process.stdin.isTTY !== true) {
          yield* Console.log("\nNot a terminal; re-run with --yes to apply.");
          return;
        }
        const go = yield* Prompt.run(Prompt.Confirm({ message: `Apply ${fixes.length} fix${fixes.length === 1 ? "" : "es"}?` }));
        if (!go) return;
      }
      const outcomes = yield* runFixes(nodes, fixes);
      const touched = nodes.filter((n) => fixes.some((f) => f.node === n.name));
      const after = narrow(yield* checkNodes(config, bundle), (name) => touched.some((n) => n.name === name));
      yield* Console.log(renderFixResults(outcomes));
      yield* Console.log("");
      yield* Console.log(renderStatus(after.results, after.findings, after.latest, { verbose: false, elapsedMs: after.elapsedMs }));
    }).pipe(reportUserErrors),
  ),
);

/**
 * MCP over stdio for agents: register `fleetx mcp` with Claude Code or Codex
 * and every T3 thread can check and fix the user's environments.
 */
const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Serve fleet_status and fleet_apply_fixes over MCP (stdio) for agents in T3 Code."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const bundle = config.nodes.some((n) => n.ssh !== null) ? yield* ownBundle : "";
      const services = yield* Effect.context<NodeServices.NodeServices | HttpClient.HttpClient>();
      const handlers = fleetHandlers({
        check: (only) =>
          Effect.gen(function* () {
            const unknown = only.filter((name) => !config.nodes.some((n) => n.name === name));
            if (unknown.length > 0) return yield* Effect.fail(`unknown machine: ${unknown.join(", ")}`);
            const report = yield* checkNodes(config, bundle);
            return narrow(report, (name) => only.length === 0 || only.includes(name));
          }).pipe(Effect.provide(services)),
        apply: (fixes) => runFixes(config.nodes, fixes).pipe(Effect.provide(services)),
        compare: (report) => compareWithLast(report.findings).pipe(Effect.provide(services)),
      });
      return yield* Layer.launch(
        McpServer.toolkit(FleetToolkit).pipe(
          Layer.provide(handlers),
          Layer.provide(McpServer.layerStdio({ name: "fleetx", version: packageJson.version, protocols: [McpProtocol.v2025_06_18] })),
        ),
      );
    }).pipe(reportUserErrors),
  ),
);

const cli = Command.make("fleetx").pipe(
  Command.withDescription("Keep every T3 Code environment equivalent."),
  Command.withSubcommands([statusCommand, fixCommand, mcpCommand, probeCommand]),
);

const RuntimeLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(RuntimeLayer),
  NodeRuntime.runMain,
);
