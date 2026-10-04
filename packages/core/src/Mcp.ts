/**
 * T3 Fleet as MCP tools, so an agent in any T3 thread can answer "what is wrong
 * with my environments?" and fix it. Built the way T3 Code builds its own
 * toolkits (effect/unstable/ai Tool and Toolkit), so these tools could join
 * T3's MCP server unchanged.
 *
 * Applying is deliberately two steps: `fleet_status` hands out fix ids, and
 * `fleet_apply_fixes` runs only ids it is given, after checking again that
 * each is still needed. An agent cannot run a command T3 Fleet did not propose.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import type { CheckReport } from "./Check.ts";
import { providerLabel, type Finding, type Fix } from "./Diagnose.ts";
import type { FixOutcome } from "./Fix.ts";
import { findingId, type Changes } from "./Memory.ts";
import { renderStatus } from "./Render.ts";

export class FleetFailure extends Schema.TaggedError<FleetFailure>()("FleetFailure", {
  message: Schema.String,
}) {}

const FindingView = Schema.Struct({
  id: Schema.String,
  node: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  area: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(
    Schema.Struct({
      command: Schema.String,
      safe: Schema.Boolean,
      disrupts: Schema.optionalKey(Schema.String),
    }),
  ),
});

const EnvironmentView = Schema.Struct({
  name: Schema.String,
  reachable: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  t3Version: Schema.NullOr(Schema.String),
  claude: Schema.NullOr(Schema.String),
  codex: Schema.NullOr(Schema.String),
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      startsInT3: Schema.Boolean,
      version: Schema.NullOr(Schema.String),
      runs: Schema.NullOr(Schema.String),
    }),
  ),
});

const StatusResult = Schema.Struct({
  summary: Schema.String,
  changes: Schema.optionalKey(
    Schema.Struct({
      since: Schema.NullOr(Schema.String),
      appeared: Schema.Array(Schema.String),
      worsened: Schema.Array(Schema.String),
      resolved: Schema.Array(Schema.String),
    }),
  ),
  environments: Schema.Array(EnvironmentView),
  findings: Schema.Array(FindingView),
});

const ApplyResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ id: Schema.String, node: Schema.String, title: Schema.String, ok: Schema.Boolean, output: Schema.String }),
  ),
  notApplied: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
  summaryAfter: Schema.String,
});

const shared = { failure: FleetFailure, failureMode: "return" as const };

const StatusTool = Tool.make("fleet_status", {
  ...shared,
  description:
    "Check every machine the user runs T3 Code on: the T3 server version against its release channel, whether each enabled provider actually starts under that T3 server's own environment, Claude Code and Codex versions, and sync health. Returns a plain-text summary to show the user, plus structured findings; a finding with `fix` can be passed to fleet_apply_fixes by id.",
  parameters: Schema.Struct({
    nodes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Only these machines. Every machine is still checked, so cross-machine findings stay accurate." }),
    changesOnly: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Also compare with the previous check made this way and fill `changes` (findings that appeared, got worse, or were resolved). For scheduled checks: when every list is empty, tell the user in one line that nothing changed.",
    }),
  }),
  success: StatusResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ApplyTool = Tool.make("fleet_apply_fixes", {
  ...shared,
  description:
    "Apply fixes proposed by fleet_status, by finding id. Checks again first and skips ids that no longer apply. A fix whose `disrupts` is set interrupts something (a T3 update restarts that machine's server and stops threads running there): name it to the user and get their agreement before applying it. Returns each outcome and a fresh summary.",
  parameters: Schema.Struct({
    fixIds: Schema.Array(Schema.String).annotate({ description: "Finding ids from fleet_status whose fix should run." }),
  }),
  success: ApplyResult,
}).annotate(Tool.Destructive, true);

const AlertsTool = Tool.make("fleet_alerts", {
  ...shared,
  description:
    "Health changes every machine reported through t3-fleet sync since the last call (a problem appeared or was resolved, sync started failing or recovered, a machine stopped reporting). Each alert is returned once. For scheduled checks: when the list is empty, say nothing beyond one short line.",
  // MCP requires an object input schema with properties; an empty struct does not produce one.
  parameters: Schema.Struct({
    peek: Schema.optionalKey(Schema.Boolean).annotate({ description: "Return the alerts without marking them seen." }),
  }),
  success: Schema.Struct({
    alerts: Schema.Array(Schema.Struct({ at: Schema.String, node: Schema.String, kind: Schema.String, message: Schema.String })),
  }),
}).annotate(Tool.Destructive, false);

export const FleetToolkit = Toolkit.make(StatusTool, ApplyTool, AlertsTool);



const view = (report: CheckReport) => ({
  summary: renderStatus(report.results, report.findings, report.latest, { verbose: false, elapsedMs: report.elapsedMs }),
  environments: report.results.map((r) =>
    r.ok
      ? {
          name: r.node.name,
          reachable: true,
          t3Version: r.observation.t3.descriptor?.serverVersion ?? r.observation.t3.installedVersion,
          claude: r.observation.agents.find((a) => a.name === "claude")?.managedVersion ?? null,
          codex: r.observation.agents.find((a) => a.name === "codex")?.managedVersion ?? null,
          providers: r.observation.t3.providers
            .filter((p) => p.enabled)
            .map((p) => ({ provider: providerLabel(p.instanceId), startsInT3: p.launch.ok, version: p.launch.version, runs: p.resolved })),
        }
      : { name: r.node.name, reachable: false, error: r.error, t3Version: null, claude: null, codex: null, providers: [] },
  ),
  findings: report.findings.map((f) => ({
    id: findingId(f),
    node: f.node,
    severity: f.severity,
    area: f.area,
    title: f.title,
    ...(f.detail === undefined ? {} : { detail: f.detail }),
    ...(f.fix === undefined
      ? {}
      : { fix: { command: f.fix.command, safe: f.fix.safe, ...(f.fix.disrupts === undefined ? {} : { disrupts: f.fix.disrupts }) } }),
  })),
});

export interface FleetActions {
  /** A full check, narrowed to `nodes` when given. */
  readonly check: (nodes: ReadonlyArray<string>) => Effect.Effect<CheckReport, string>;
  /** Compare a full check with the remembered one, and remember it. */
  readonly compare: (report: CheckReport) => Effect.Effect<Changes>;
  /** Alerts published since the last call, marked seen. */
  readonly alerts: (peek: boolean) => Effect.Effect<ReadonlyArray<{ readonly at: number; readonly node: string; readonly kind: string; readonly message: string }>, string>;
  readonly apply: (fixes: ReadonlyArray<Finding & { readonly fix: Fix }>) => Effect.Effect<ReadonlyArray<FixOutcome>>;
}

const toFailure = (message: string) => new FleetFailure({ message });

export const fleetHandlers = (actions: FleetActions) =>
  FleetToolkit.toLayer({
    fleet_status: ({ nodes, changesOnly }) =>
      Effect.gen(function* () {
        const report = yield* actions.check(nodes ?? []).pipe(Effect.mapError(toFailure));
        if (changesOnly !== true) return view(report);
        const changes = yield* actions.compare(report);
        return {
          ...view(report),
          changes: {
            since: changes.since === null ? null : DateTime.formatIso(DateTime.makeUnsafe(changes.since)),
            appeared: changes.appeared.map((f) => `${f.node}: ${f.title}`),
            worsened: changes.worsened.map((f) => `${f.node}: ${f.title}`),
            resolved: changes.resolved.map((f) => f.title === "" ? f.id : `${f.id.split(":")[0]}: ${f.title}`),
          },
        };
      }),
    fleet_alerts: ({ peek }) =>
      actions.alerts(peek === true).pipe(
        Effect.map((alerts) => ({
          alerts: alerts.map((a) => ({ at: DateTime.formatIso(DateTime.makeUnsafe(a.at)), node: a.node, kind: a.kind, message: a.message })),
        })),
        Effect.mapError(toFailure),
      ),
    fleet_apply_fixes: ({ fixIds }) =>
      Effect.gen(function* () {
        const before = yield* actions.check([]).pipe(Effect.mapError(toFailure));
        const byId = new Map(before.findings.map((f) => [findingId(f), f]));
        const chosen: Array<Finding & { readonly fix: Fix }> = [];
        const notApplied: Array<{ id: string; reason: string }> = [];
        for (const id of fixIds) {
          const finding = byId.get(id);
          if (finding === undefined) notApplied.push({ id, reason: "no longer found; it may already be fixed" });
          else if (finding.fix === undefined) notApplied.push({ id, reason: "this finding has no automatic fix" });
          else chosen.push(finding as Finding & { readonly fix: Fix });
        }
        const outcomes = yield* actions.apply(chosen);
        const touched = [...new Set(chosen.map((f) => f.node))];
        const after = touched.length === 0 ? before : yield* actions.check(touched).pipe(Effect.mapError(toFailure));
        return {
          results: outcomes.map((o) => ({ id: findingId(o.finding), node: o.finding.node, title: o.finding.title, ok: o.ok, output: o.summary })),
          notApplied,
          summaryAfter: view(after).summary,
        };
      }),
  });
