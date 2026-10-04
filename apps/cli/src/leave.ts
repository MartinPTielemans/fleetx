/**
 * `t3-fleet leave`: take this machine out of the fleet and leave it working on
 * its own (Leave.ts has what each step does). Like `fix`, it shows the plan
 * first and asks; `--dry-run` stops after the plan, `--yes` skips the question.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";

import {
  applyLeave,
  currentDeparture,
  departurePath,
  planLeave,
  retireDeparture,
  type LeaveOutcome,
  type LeavePlan,
} from "@t3-fleet/core/Leave";

import { reportUserErrors } from "./shared.ts";

export const renderLeavePlan = (plan: LeavePlan) => {
  const lines = [`t3-fleet leave  ${plan.departure.node}`];
  if (plan.refusal !== null) {
    lines.push("", `  ${plan.refusal}`);
    return lines.join("\n");
  }
  plan.steps.forEach((step, i) => {
    lines.push("", `  ${i + 1}. ${step.title}`);
    for (const line of step.lines) lines.push(`       ${line}`);
  });
  if (plan.notes.length > 0) {
    lines.push("");
    for (const note of plan.notes) lines.push(`  · ${note}`);
  }
  return lines.join("\n");
};

export const renderLeaveResults = (plan: LeavePlan, outcomes: ReadonlyArray<LeaveOutcome>) => {
  const lines: Array<string> = [];
  for (const o of outcomes) {
    lines.push(`  ${o.ok ? "✓" : "✗"} ${o.title}`);
    for (const line of o.lines) lines.push(`      ${line}`);
  }
  const skipped = plan.steps.slice(outcomes.length);
  if (skipped.length > 0) {
    lines.push("", "  Stopped there; these did not run:");
    for (const s of skipped) lines.push(`    ${s.title}`);
    lines.push("", "  Run t3-fleet leave again to go on from here.");
  }
  return lines.join("\n");
};

export const leaveCommand = Command.make("leave", {
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Leave without asking."),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withAlias("n"),
    Flag.withDescription("Show the plan and stop."),
    Flag.withDefault(false),
  ),
  retire: Flag.Boolean("retire").pipe(
    Flag.withDescription(
      "Set aside the record of a departure that is over or given up; changes nothing else.",
    ),
    Flag.withDefault(false),
  ),
  purge: Flag.Boolean("purge").pipe(
    Flag.withDescription(
      "Also remove ~/.config/t3-fleet (key and secrets), ~/.local/state/t3-fleet and the installed bundle.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Take this machine out of the fleet and give back what it had, after showing the plan.",
  ),
  Command.withHandler(({ yes, dryRun, purge, retire }) =>
    Effect.gen(function* () {
      const home = process.env["HOME"] ?? "";
      if (retire) {
        const to = yield* retireDeparture(home, { dryRun });
        yield* Console.log(
          to === null
            ? "No departure is recorded here."
            : dryRun
              ? `Would set ~/${departurePath(home).slice(home.length + 1)} aside as ${to.replace(home, "~")}; nothing was changed.`
              : `Set the departure's record aside as ${to.replace(home, "~")}; nothing else changed.`,
        );
        return;
      }
      const { departure, resumed } = yield* currentDeparture(home);
      if (resumed)
        yield* Console.log(
          departure.finished
            ? `${departure.node} has left the fleet; this finishes what is left here.\n`
            : `Going on with ${departure.node}'s unfinished departure.\n`,
        );
      const plan = yield* planLeave(departure, { home, purge });
      yield* Console.log(renderLeavePlan(plan));
      if (plan.refusal === null && plan.steps.length === 0) {
        // Recorded as finished, so a later run does not take it for one still going.
        if (!dryRun) yield* applyLeave(plan);
        yield* Console.log("\nNothing left to do.");
        return;
      }
      if (plan.refusal !== null) {
        process.exitCode = 1;
        return;
      }
      if (dryRun) return;
      if (!yes) {
        if (process.stdin.isTTY !== true) {
          yield* Console.log("\nNot a terminal; re-run with --yes to leave.");
          return;
        }
        const go = yield* Prompt.run(
          Prompt.Confirm({ message: `Take ${plan.departure.node} out of the fleet?` }),
        );
        if (!go) return;
      }
      const outcomes = yield* applyLeave(plan);
      yield* Console.log("");
      yield* Console.log(renderLeaveResults(plan, outcomes));
      if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
    }).pipe(reportUserErrors),
  ),
);
