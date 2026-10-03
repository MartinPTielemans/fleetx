/**
 * The terminal report: one row per environment, then what to do about it.
 * Plain text that reads the same piped into a file or an agent's context;
 * colour only when a person is looking at a terminal.
 */
import * as DateTime from "effect/DateTime";

import { providerLabel, shortT3, type Finding, type Severity } from "./Diagnose.ts";
import type { Latest } from "./Latest.ts";
import { releasesBehind } from "./Latest.ts";
import type { Changes } from "./Memory.ts";
import type { MachineObservation } from "./Observation.ts";
import type { NodeResult } from "./Remote.ts";

const useColor = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const c = { dim: paint("2"), bold: paint("1"), red: paint("31"), green: paint("32"), yellow: paint("33"), cyan: paint("36") };

/** Width of `text` as the terminal shows it: escapes take no columns. */
// eslint-disable-next-line no-control-regex
const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visible(text)));

const MARK: Readonly<Record<Severity | "ok", string>> = {
  ok: c.green("✓"),
  error: c.red("✗"),
  warn: c.yellow("!"),
  info: c.dim("·"),
};


const ago = (seconds: number) =>
  seconds < 90 ? `${Math.max(0, Math.round(seconds))}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;

const worst = (findings: ReadonlyArray<Finding>): Severity | "ok" =>
  findings.some((f) => f.severity === "error") ? "error" : findings.some((f) => f.severity === "warn") ? "warn" : "ok";

const row = (obs: MachineObservation, name: string, findings: ReadonlyArray<Finding>, latest: Latest): Array<string> => {
  const mine = findings.filter((f) => f.node === name);

  const version = obs.t3.descriptor?.serverVersion ?? obs.t3.installedVersion;
  let t3: string;
  if (obs.t3.runtime === null) t3 = obs.t3.problems.length > 0 ? `${MARK.warn} ${c.yellow("not running")}` : c.dim("not installed");
  else if (version === null) t3 = `${MARK.error} ${c.red("not running")}`;
  else {
    const { behind, newest } = releasesBehind(latest, version);
    const lag = newest !== null && newest !== version ? (behind === null ? " behind" : ` -${behind}`) : "";
    const state = worst(mine.filter((f) => f.area === "t3"));
    t3 = `${MARK[state]} ${shortT3(version)}${state === "ok" ? c.dim(lag) : c.yellow(lag)}`;
  }

  const agent = (name: "claude" | "codex") => {
    const a = obs.agents.find((x) => x.name === name);
    if (a === undefined || a.managedVersion === null) return `${MARK.error} ${c.red("missing")}`;
    const flagged = mine.filter((f) => f.area === "agents" && f.severity !== "info" && f.title.includes(name));
    return `${MARK[worst(flagged)]} ${a.managedVersion}`;
  };

  const providers = obs.t3.providers
    .filter((p) => p.enabled)
    .map((p) => {
      const label = providerLabel(p.instanceId);
      const flagged = mine.filter((f) => (f.area === "providers" || f.area === "parity") && f.title.includes(label));
      const state = p.launch.ok ? worst(flagged) : "error";
      return `${MARK[state]} ${label}`;
    })
    .join("  ");

  const sync = obs.lastSync;
  const syncCell =
    sync === null
      ? c.dim("—")
      : `${sync.result === "ok" && sync.streak === 0 ? MARK.ok : MARK.error} ${ago(obs.observedAt / 1000 - sync.when)} ago`;

  return [c.bold(name), t3, agent("claude"), agent("codex"), providers || c.dim("none enabled"), syncCell];
};

export const renderStatus = (
  results: ReadonlyArray<NodeResult>,
  findings: ReadonlyArray<Finding>,
  latest: Latest,
  options: { readonly verbose: boolean; readonly elapsedMs: number },
): string => {
  const lines: Array<string> = [];
  const errors = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const notes = findings.filter((f) => f.severity === "info").length;
  const counts = [
    errors > 0 ? c.red(`${errors} problem${errors === 1 ? "" : "s"}`) : "",
    warns > 0 ? c.yellow(`${warns} warning${warns === 1 ? "" : "s"}`) : "",
    notes > 0 ? c.dim(`${notes} note${notes === 1 ? "" : "s"}`) : "",
  ].filter(Boolean);
  const summary = errors + warns === 0 ? [c.green("everything matches"), ...counts].join(", ") : counts.join(", ");
  lines.push(`${c.bold("fleetx")}  ${results.length} environment${results.length === 1 ? "" : "s"}  ${summary}  ${c.dim(`(${(options.elapsedMs / 1000).toFixed(1)}s)`)}`);
  lines.push("");

  const header = ["", "T3", "CLAUDE", "CODEX", "PROVIDERS IN T3", "SYNC"];
  const rows: Array<Array<string>> = results.map((r) =>
    r.ok ? row(r.observation, r.node.name, findings, latest) : [c.bold(r.node.name), `${MARK.error} ${c.red("unreachable")}`, "", "", "", ""],
  );
  const widths = header.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ""))));
  lines.push("  " + header.map((h, i) => pad(c.dim(h), (widths[i] ?? 0) + 2)).join("").trimEnd());
  for (const r of rows) lines.push("  " + r.map((cell, i) => pad(cell, (widths[i] ?? 0) + 2)).join("").trimEnd());

  const shown = findings.filter((f) => options.verbose || f.severity !== "info");
  if (shown.length > 0) {
    lines.push("");
    const nameWidth = Math.max(...shown.map((f) => f.node.length));
    for (const f of shown) {
      lines.push(`  ${MARK[f.severity]} ${pad(f.node, nameWidth)}  ${f.severity === "info" ? c.dim(f.title) : f.title}`);
      const indent = " ".repeat(nameWidth + 6);
      if (f.detail) lines.push(`${indent}${c.dim(f.detail)}`);
      if (f.fix) lines.push(`${indent}${c.cyan("fix")} ${f.fix.command.split("\n").join(`\n${indent}    `)}`);
    }
  }
  if (!options.verbose && notes > 0) {
    lines.push("");
    lines.push(c.dim(`  ${notes} note${notes === 1 ? "" : "s"} hidden; --verbose shows them`));
  }
  return lines.join("\n");
};

const groupByNode = <T extends { readonly node: string }>(items: ReadonlyArray<T>) => {
  const groups = new Map<string, Array<T>>();
  for (const item of items) groups.set(item.node, [...(groups.get(item.node) ?? []), item]);
  return groups;
};

/** What `fix` is about to do, and what it leaves for a person to decide. */
export const renderFixPlan = (
  fixes: ReadonlyArray<Finding & { readonly fix: NonNullable<Finding["fix"]> }>,
  findings: ReadonlyArray<Finding>,
  skipped: ReadonlyArray<Finding> = [],
): string => {
  const lines: Array<string> = [];
  const manual = findings.filter((f) => f.fix === undefined && f.severity !== "info");
  if (fixes.length === 0) {
    lines.push(`${c.bold("fleetx fix")}  nothing to apply`);
  } else {
    const machines = new Set(fixes.map((f) => f.node)).size;
    lines.push(`${c.bold("fleetx fix")}  ${fixes.length} fix${fixes.length === 1 ? "" : "es"} on ${machines} machine${machines === 1 ? "" : "s"}`);
    for (const [node, items] of groupByNode(fixes)) {
      lines.push("");
      for (const f of items) {
        lines.push(`  ${c.bold(pad(node, 9))} ${f.title}`);
        const where = f.fix.on !== undefined && f.fix.on !== f.node ? c.dim(` (runs on ${f.fix.on})`) : "";
        lines.push(`  ${" ".repeat(9)} ${c.cyan("$")} ${f.fix.command.split("\n").join(`\n  ${" ".repeat(11)} `)}${where}`);
        if (f.fix.disrupts) lines.push(`  ${" ".repeat(9)} ${c.yellow(`interrupts: ${f.fix.disrupts}`)}`);
      }
    }
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(c.dim(`  ${skipped.length} fix${skipped.length === 1 ? "" : "es"} left out by --safe because ${skipped.length === 1 ? "it interrupts" : "they interrupt"} something:`));
    for (const f of skipped) lines.push(c.dim(`    ${f.node}: ${f.title}`));
  }
  if (manual.length > 0) {
    lines.push("");
    lines.push(c.dim(`  ${manual.length} finding${manual.length === 1 ? " needs" : "s need"} a decision rather than a command:`));
    for (const f of manual) lines.push(c.dim(`    ${f.node}: ${f.title}`));
  }
  return lines.join("\n");
};

export const renderFixResults = (
  outcomes: ReadonlyArray<{ readonly finding: Finding; readonly ok: boolean; readonly summary: string }>,
): string => {
  const lines = ["", c.bold("Results")];
  for (const o of outcomes) {
    lines.push(`  ${o.ok ? MARK.ok : MARK.error} ${pad(o.finding.node, 9)} ${o.finding.title}`);
    if (o.summary) lines.push(`    ${" ".repeat(10)}${c.dim(o.summary)}`);
  }
  return lines.join("\n");
};

/** What changed since the last remembered check; one line when nothing did. */
export const renderChanges = (changes: Changes): string => {
  if (changes.since === null) return c.dim("first check; future runs with --changes report only what changed");
  const since = DateTime.formatIso(DateTime.makeUnsafe(changes.since)).slice(0, 16).replace("T", " ");
  const lines: Array<string> = [];
  for (const f of changes.appeared) lines.push(`  ${MARK[f.severity]} new       ${pad(f.node, 9)} ${f.title}`);
  for (const f of changes.worsened) lines.push(`  ${MARK.error} worse     ${pad(f.node, 9)} ${f.title}`);
  for (const f of changes.resolved) lines.push(`  ${MARK.ok} resolved  ${pad(f.id.split(":")[0] ?? "", 9)} ${f.title}`);
  return lines.length === 0
    ? c.dim(`no change since ${since} UTC`)
    : [`${c.bold("Since")} ${since} UTC`, ...lines].join("\n");
};

/** A titled list of findings, for commands that show one area. */
export const renderFindings = (title: string, machines: number, findings: ReadonlyArray<Finding>, elapsedMs: number): string => {
  const lines = [`${c.bold(title)}  ${machines} environment${machines === 1 ? "" : "s"}  ${findings.length === 0 ? c.green("all good") : `${findings.length} finding${findings.length === 1 ? "" : "s"}`}  ${c.dim(`(${(elapsedMs / 1000).toFixed(1)}s)`)}`];
  if (findings.length > 0) lines.push("");
  const width = Math.max(0, ...findings.map((f) => f.node.length));
  for (const f of findings) {
    lines.push(`  ${MARK[f.severity]} ${pad(f.node, width)}  ${f.title}`);
    if (f.detail) lines.push(`${" ".repeat(width + 6)}${c.dim(f.detail)}`);
    if (f.fix) lines.push(`${" ".repeat(width + 6)}${c.cyan("fix")} ${f.fix.command.split("\n").join(`\n${" ".repeat(width + 10)}`)}`);
  }
  return lines.join("\n");
};
