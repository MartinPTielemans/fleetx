/**
 * Commands that work through the config repo rather than ssh: sync, the
 * proposal workflow, the fleet's published state, alerts, skill adoption.
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { expandHome, loadConfig, type Config } from "@fleetx/core/Config";
import type { Finding } from "@fleetx/core/Diagnose";
import { exec } from "@fleetx/core/Exec";
import { lookupLatest } from "@fleetx/core/Latest";
import type { NodeResult } from "@fleetx/core/Remote";
import { renderStatus } from "@fleetx/core/Render";
import { approve, listProposals, reject } from "@fleetx/core/Staging";
import { readStates, syncRun, type Alert, type NodeState } from "@fleetx/core/Sync";

import { reportUserErrors } from "./shared.ts";

export const syncCommand = Command.make("sync", {
  noApply: Flag.Boolean("no-apply").pipe(Flag.withDescription("Report only; run no fixes."), Flag.withDefault(false)),
}).pipe(
  Command.withDescription("Propose, pull, converge this machine, publish its state. What the timer runs."),
  Command.withHandler(({ noApply }) =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const result = yield* syncRun(config, { apply: !noApply });
      for (const line of result.lines) yield* Console.log(line);
      if (result.state !== null) {
        yield* Console.log(`${result.state.result === "ok" ? "synced" : "sync incomplete"} at ${result.state.rev}: ${result.state.message}`);
        if (result.state.result !== "ok") process.exitCode = 1;
      }
    }).pipe(reportUserErrors),
  ),
);

/** The fleet as its nodes last reported it, without contacting any of them. */
export const fleetFromStates = (config: Config) =>
  Effect.gen(function* () {
    const states = yield* readStates(config.repo);
    const now = yield* Clock.currentTimeMillis;
    const results: Array<NodeResult> = [];
    const findings: Array<Finding> = [];
    for (const node of config.nodes) {
      const state = states.find((s) => s.node === node.name);
      if (state === undefined || state.observation === null) {
        results.push({ node, ok: false, error: "has not published any state yet (no fleetx sync has run there)", ms: 0 });
        continue;
      }
      results.push({
        node,
        ok: true,
        observation: { ...state.observation, legacySync: { when: Math.round(state.at / 1000), result: state.result, message: state.message, streak: state.streak } },
        ms: 0,
      });
      findings.push(...(state.findings as ReadonlyArray<Finding>));
      const ageSeconds = (now - state.at) / 1000;
      if (ageSeconds > config.interval * config.alertAfter) {
        findings.push({ node: node.name, key: "state-stale", severity: "error", area: "sync", title: `last reported ${Math.round(ageSeconds / 60)} minutes ago; is its timer running?` });
      }
    }
    return { states, results, findings };
  });

export const renderFleetFromStates = (config: Config, verbose: boolean) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const { results, findings } = yield* fleetFromStates(config);
    const latest = yield* lookupLatest(
      results.flatMap((r) => (r.ok ? [r.observation.t3.descriptor?.serverVersion ?? r.observation.t3.installedVersion ?? ""] : [])).filter(Boolean),
    );
    const order = { error: 0, warn: 1, info: 2 } as const;
    const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.node.localeCompare(b.node));
    return renderStatus(results, sorted, latest, { verbose, elapsedMs: (yield* Clock.currentTimeMillis) - started });
  });

const asAuthority = Effect.gen(function* () {
  const config = yield* loadConfig;
  if (!config.nodes.find((n) => n.name === config.self)?.roles.includes("authority")) {
    return yield* Effect.fail(`${config.self} is not an authority; review proposals on a node with the authority role`);
  }
  return config;
});

export const reviewCommand = Command.make("review").pipe(
  Command.withDescription("List proposals waiting for approval."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* loadConfig;
      const proposals = yield* listProposals(config.repo, config.branch);
      if (proposals.length === 0) {
        yield* Console.log("no proposals waiting");
        return;
      }
      for (const p of proposals) {
        yield* Console.log(`${p.node}  (${p.commit.slice(0, 7)})\n${p.stat.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
      }
      yield* Console.log("fleetx approve <node>   or   fleetx reject <node>");
    }).pipe(reportUserErrors),
  ),
);

const proposalOf = (config: Config, node: string) =>
  Effect.gen(function* () {
    const proposal = (yield* listProposals(config.repo, config.branch)).find((p) => p.node === node);
    if (proposal === undefined) return yield* Effect.fail(`no proposal from ${node}`);
    return proposal;
  });

export const approveCommand = Command.make("approve", { node: Argument.String("node") }).pipe(
  Command.withDescription("Apply a node's proposal to the branch (authority)."),
  Command.withHandler(({ node }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      const rev = yield* approve(config.repo, config.branch, yield* proposalOf(config, node), config.self);
      yield* Console.log(`approved ${node}'s proposal (${rev})`);
    }).pipe(reportUserErrors),
  ),
);

export const rejectCommand = Command.make("reject", { node: Argument.String("node") }).pipe(
  Command.withDescription("Decline a node's proposal; that node sets its edits aside on its next sync (authority)."),
  Command.withHandler(({ node }) =>
    Effect.gen(function* () {
      const config = yield* asAuthority;
      yield* reject(config.repo, yield* proposalOf(config, node));
      yield* Console.log(`rejected ${node}'s proposal`);
    }).pipe(reportUserErrors),
  ),
);

const seenPath = (home: string) => `${home}/.local/state/fleetx/alerts-seen`;

/** Alerts every node published since the last call; marks them seen. */
export const takeAlerts = (config: Config) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = process.env["HOME"] ?? "";
    const seen = Number(Option.getOrElse(yield* fs.readFileString(seenPath(home)).pipe(Effect.option), () => "0").trim()) || 0;
    const { states, findings } = yield* fleetFromStates(config);
    const alerts: Array<Alert> = states.flatMap((s: NodeState) => s.alerts).filter((a) => a.at > seen);
    // A node that stopped reporting cannot publish an alert about itself.
    for (const f of findings.filter((x) => x.key === "state-stale")) alerts.push({ at: yield* Clock.currentTimeMillis, node: f.node, kind: "failing", message: f.title });
    alerts.sort((a, b) => a.at - b.at);
    const newest = Math.max(seen, ...states.flatMap((s) => s.alerts.map((a) => a.at)));
    yield* fs.makeDirectory(`${home}/.local/state/fleetx`, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFileString(seenPath(home), String(newest));
    return alerts;
  });

export const alertsCommand = Command.make("alerts").pipe(
  Command.withDescription("Print health changes every machine reported since the last call."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const alerts = yield* takeAlerts(yield* loadConfig);
      if (alerts.length === 0) yield* Console.log("no new alerts");
      for (const a of alerts) yield* Console.log(`${a.kind.padEnd(9)} ${a.node.padEnd(10)} ${a.message}`);
    }).pipe(reportUserErrors),
  ),
);

const adopt = Command.make("adopt", {
  name: Argument.String("skill"),
  from: Flag.String("from").pipe(Flag.withDescription("Directory the skill was installed into.")),
}).pipe(
  Command.withDescription("Move a skill installed outside fleetx into the config repo; sync proposes or commits it."),
  Command.withHandler(({ name, from }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* loadConfig;
      const home = process.env["HOME"] ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return yield* Effect.fail(`not a skill name: ${name}`);
      const src = path.join(expandHome(from, home), name);
      const dest = path.join(config.repo, "skills", name);
      if (!(yield* fs.exists(path.join(src, "SKILL.md")).pipe(Effect.orElseSucceed(() => false)))) return yield* Effect.fail(`${src} has no SKILL.md`);
      if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) return yield* Effect.fail(`skills/${name} already exists in the repo`);
      const copy = yield* exec({ command: "cp", args: ["-R", src, dest], timeout: Duration.seconds(30) });
      if (copy.code !== 0) return yield* Effect.fail(`copying: ${copy.stderr.trim()}`);
      const aside = path.join(home, ".local/state/fleetx/adopted", String(yield* Clock.currentTimeMillis));
      yield* fs.makeDirectory(aside, { recursive: true });
      yield* fs.rename(src, path.join(aside, name));
      yield* Console.log(`skills/${name} is in the repo; the original is in ${aside}. The next sync links it and ${config.nodes.find((n) => n.name === config.self)?.roles.includes("authority") ? "commits" : "proposes"} it.`);
    }).pipe(reportUserErrors),
  ),
);

export const skillsCommand = Command.make("skills").pipe(
  Command.withDescription("Skills vendored in the config repo."),
  Command.withSubcommands([adopt]),
);
