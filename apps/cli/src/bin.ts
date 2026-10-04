#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { checkNodes } from "@t3-fleet/core/Check";
import type { Finding, Fix } from "@t3-fleet/core/Diagnose";
import { runFixes } from "@t3-fleet/core/Fix";
import { loadConfig, ProbeSettings } from "@t3-fleet/core/Config";
import { FleetToolkit, fleetHandlers } from "@t3-fleet/core/Mcp";
import { compareWithLast } from "@t3-fleet/core/Memory";
import { MachineObservation } from "@t3-fleet/core/Observation";
import { probeMachine } from "@t3-fleet/core/Probe";
import { renderChanges, renderFindings, renderFixPlan, renderFixResults, renderStatus } from "@t3-fleet/core/Render";
import { describeMerged } from "@t3-fleet/core/Settings";

import packageJson from "../package.json" with { type: "json" };
import { alertsCommand, approveCommand, mcpAddCommand, takeAlerts, rejectCommand, renderFleetFromStates, repoCommand, reviewCommand, skillsCommand, syncCommand } from "./fleet.ts";
import { hubCommands } from "./hub.ts";
import { initCommand, inviteCommand, joinCommand } from "./onboard.ts";
import { modelsCommand } from "./models.ts";
import { listenCommand, relayCommand } from "./relay.ts";
import { secretsCommand } from "./secrets.ts";
import { t3Command } from "./t3.ts";
import { uiCommand } from "./ui.ts";
import { encodeJson, narrow, nodeFlag, ownBundle, prepare, reportUserErrors } from "./shared.ts";

const encodeObservation = Schema.encodeEffect(Schema.fromJsonString(MachineObservation));

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

const statusCommand = Command.make("status", {
  json: Flag.Boolean("json").pipe(Flag.withDescription("Print machine-readable JSON."), Flag.withDefault(false)),
  verbose: Flag.Boolean("verbose").pipe(Flag.withDescription("Also show notes."), Flag.withDefault(false)),
  all: Flag.Boolean("all").pipe(
    Flag.withDescription("Every machine as it last reported through the config repo; contacts none of them."),
    Flag.withDefault(false),
  ),
  changes: Flag.Boolean("changes").pipe(
    Flag.withDescription("Only what changed since the last --changes run (for scheduled checks)."),
    Flag.withDefault(false),
  ),
  node: nodeFlag,
}).pipe(
  Command.withDescription("Check every environment: T3, the providers it launches, agent CLIs, sync."),
  Command.withHandler(({ json, verbose, all, changes, node }) =>
    Effect.gen(function* () {
      if (all) {
        yield* Console.log(yield* renderFleetFromStates(yield* loadConfig, verbose));
        return;
      }
      const { config, bundle, shown } = yield* prepare(node);
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
  area: Flag.String("area").pipe(Flag.withDescription("Only fixes in this area (repeatable): engine, secrets, mcp, …"), Flag.atLeast(0)),
  node: nodeFlag,
}).pipe(
  Command.withDescription("Apply the fixes `status` suggests, after showing them."),
  Command.withHandler(({ yes, safe, dryRun, area, node }) =>
    Effect.gen(function* () {
      const { config, nodes, bundle, shown } = yield* prepare(node);
      const report = narrow(yield* checkNodes(config, bundle), shown);
      const fixes = report.findings.filter(
        (f): f is Finding & { readonly fix: Fix } =>
          f.fix !== undefined && (!safe || f.fix.safe) && (area.length === 0 || area.includes(f.area)),
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
      const outcomes = yield* runFixes(nodes, fixes, config.checkout, bundle);
      const touched = nodes.filter((n) => fixes.some((f) => f.node === n.name));
      const after = narrow(yield* checkNodes(config, bundle), (name) => touched.some((n) => n.name === name));
      yield* Console.log(renderFixResults(outcomes));
      yield* Console.log("");
      yield* Console.log(renderStatus(after.results, after.findings, after.latest, { verbose: false, elapsedMs: after.elapsedMs }));
    }).pipe(reportUserErrors),
  ),
);

const doctorCommand = Command.make("doctor", { node: nodeFlag }).pipe(
  Command.withDescription("Check what T3 Fleet and T3 run on: Node, git transport, PATH, T3 Fleet's own git config."),
  Command.withHandler(({ node }) =>
    Effect.gen(function* () {
      const { config, bundle, shown } = yield* prepare(node);
      const report = narrow(yield* checkNodes(config, bundle), shown);
      const findings = report.findings.filter((f) => f.area === "runtime" || f.area === "reach");
      yield* Console.log(renderFindings("t3-fleet doctor", report.results.length, findings, report.elapsedMs));
      if (findings.some((f) => f.severity === "error")) process.exitCode = 1;
    }).pipe(reportUserErrors),
  ),
);

const configShowCommand = Command.make("show", {
  node: Argument.String("node").pipe(Argument.withDescription("Machine to show; defaults to this one."), Argument.withDefault("")),
}).pipe(
  Command.withDescription("Print a machine's merged settings, and which layer each value comes from."),
  Command.withHandler(({ node }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const name = node === "" ? config.self : node;
      const found = config.nodes.find((n) => n.name === name);
      if (found === undefined) return yield* Effect.fail(`unknown machine: ${name}`);
      yield* Console.log(`${name}  roles: ${found.roles.join(", ")}  profiles: ${found.profiles.join(", ") || "none"}  ssh: ${found.ssh ?? "(this machine)"}`);
      const rows = describeMerged(found.settings);
      const width = Math.min(60, Math.max(0, ...rows.map((r) => r.path.length + r.value.length + 3)));
      for (const row of rows) yield* Console.log(`  ${`${row.path} = ${row.value}`.padEnd(width)}  # ${row.source}`);
    }).pipe(reportUserErrors),
  ),
);

const configCommand = Command.make("config").pipe(
  Command.withDescription("Inspect the fleet's configuration."),
  Command.withSubcommands([configShowCommand]),
);

/**
 * MCP over stdio for agents: register `t3-fleet mcp` with Claude Code or Codex
 * and every T3 thread can check and fix the user's environments.
 */
const mcpServeCommand = Command.make("mcp").pipe(
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
        apply: (fixes) => runFixes(config.nodes, fixes, config.checkout, bundle).pipe(Effect.provide(services)),
        compare: (report) => compareWithLast(report.findings).pipe(Effect.provide(services)),
        alerts: (peek) => takeAlerts(config, peek).pipe(
          Effect.provide(services),
          Effect.mapError((e) => (typeof e === "string" ? e : "reading alerts failed")),
        ),
      });
      return yield* Layer.launch(
        McpServer.toolkit(FleetToolkit).pipe(
          Layer.provide(handlers),
          Layer.provide(McpServer.layerStdio({ name: "t3-fleet", version: packageJson.version, protocols: [McpProtocol.v2025_06_18] })),
        ),
      );
    }).pipe(reportUserErrors),
  ),
);

const cli = Command.make("t3-fleet").pipe(
  Command.withDescription("Keep every T3 Code environment equivalent."),
  Command.withSubcommands([
    initCommand,
    inviteCommand,
    joinCommand,
    statusCommand,
    fixCommand,
    syncCommand,
    reviewCommand,
    approveCommand,
    rejectCommand,
    repoCommand,
    alertsCommand,
    listenCommand,
    relayCommand,
    modelsCommand,
    t3Command,
    doctorCommand,
    configCommand,
    secretsCommand,
    skillsCommand,
    uiCommand,
    mcpServeCommand.pipe(Command.withSubcommands([mcpAddCommand, ...hubCommands])),
    probeCommand,
  ]),
);

const RuntimeLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(RuntimeLayer),
  NodeRuntime.runMain,
);
