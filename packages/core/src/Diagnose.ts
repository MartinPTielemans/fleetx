/**
 * Turning observations into findings. This is where fleetx decides what
 * matters, so every rule here answers one question: would the user act on
 * this? A finding names the machine, says what is wrong in plain words, and,
 * when there is one, gives the exact command that fixes it.
 *
 * Some findings need more than one machine (a provider enabled everywhere but
 * one), which is why diagnosis runs on the controller, not in the probe.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AnyArea } from "./Area.ts";
import { AREAS } from "./Areas.ts";
import type { FleetSettings, Node, ProxySettings } from "./Config.ts";
import type { Latest } from "./Latest.ts";
import { releasesBehind } from "./Latest.ts";
import type { AgentObservation, MachineObservation, ProviderObservation } from "./Observation.ts";
import type { NodeResult } from "./Remote.ts";
import { cliReleaseChannelOf } from "./vendor/t3/cliRelease.ts";

export type Severity = "error" | "warn" | "info";
/** "reach", "t3", "providers", "agents", "sync", "parity", or a registered area's id. */
export type Area = string;

export interface Fix {
  /** Shell command, run on `node`. */
  readonly command: string;
  /** Safe to run unattended: upgrades and reinstalls, never configuration changes. */
  readonly safe: boolean;
  /** What running it interrupts, when it interrupts anything. */
  readonly disrupts?: string;
  /** Run on this node instead of the finding's (an authority, for repo changes). */
  readonly on?: string;
}

export interface Finding {
  readonly node: string;
  /** Stable short name for what is wrong, unique per machine: "t3-behind", "codex-not-managed-in-t3". */
  readonly key: string;
  readonly severity: Severity;
  readonly area: Area;
  readonly title: string;
  readonly detail?: string;
  readonly fix?: Fix;
}

/** Which agent CLI a T3 provider driver runs. */
const DRIVER_AGENT: Readonly<Record<string, "claude" | "codex">> = { claudeAgent: "claude", codex: "codex" };

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether T3 starts this provider through the proxy launcher the config declares for it. */
const viaLauncher = (proxy: ProxySettings | undefined, instanceId: string, binaryPath: string | null) => {
  const launcher = proxy?.launchers[instanceId];
  return launcher !== undefined && binaryPath !== null && basename(binaryPath) === basename(launcher);
};

/** "0.0.46-nightly.20261003.2623" → "0.0.46 nightly 10-03". */
export const shortT3 = (version: string) => {
  const m = /^(\d+\.\d+\.\d+)-(nightly|preview)\.\d{4}(\d{2})(\d{2})\.\d+$/.exec(version);
  return m ? `${m[1]} ${m[2]} ${m[3]}-${m[4]}` : version;
};

/** The UTC day a nightly or preview build was cut, from its version; null for stable. */
const releaseDay = (version: string): number | null => {
  const m = /-(?:nightly|preview)\.(\d{4})(\d{2})(\d{2})\./.exec(version);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** Short forms, unless that would make two different builds look identical. */
const versionPair = (from: string, to: string) =>
  shortT3(from) === shortT3(to) ? `${from} → ${to}` : `${shortT3(from)} → ${shortT3(to)}`;

/** What people call a provider instance: "claude", not "claudeAgent". */
export const providerLabel = (instanceId: string) => (instanceId === "claudeAgent" ? "claude" : instanceId);

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+\//, "~/").replace(/^\/root\//, "~/");

const AGENT_INSTALL: Readonly<Record<"claude" | "codex", { install: string; upgrade: string }>> = {
  claude: {
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    upgrade: "~/.local/bin/claude update",
  },
  codex: {
    install: "npm install -g --prefix ~/.local @openai/codex@latest",
    upgrade: "npm install -g --prefix ~/.local @openai/codex@latest",
  },
};

/**
 * Session wrappers in the system temp directory (cmux puts its per-terminal
 * claude/codex shims there) hand off to the real binary and vanish with the
 * session; they are not installed copies.
 */
const isSessionShim = (path: string) => /^(\/private)?\/(var\/folders|tmp)\//.test(path);

/**
 * How a node wants an agent CLI's version to move, from `[agents.<name>]
 * policy`: "track" (the latest release, the default), "pin:<version>", or
 * "manual" (installed, but its version is left alone).
 */
type Policy = { readonly kind: "track" } | { readonly kind: "pin"; readonly version: string } | { readonly kind: "manual" };

const policyOf = (settings: unknown, agent: string): Policy => {
  const raw = (settings as { agents?: Record<string, { policy?: unknown }> } | undefined)?.agents?.[agent]?.policy;
  if (raw === "manual") return { kind: "manual" };
  if (typeof raw === "string" && raw.startsWith("pin:")) return { kind: "pin", version: raw.slice(4) };
  return { kind: "track" };
};

const pinCommand = (agent: "claude" | "codex", version: string) =>
  agent === "claude"
    ? `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`
    : `npm install -g --prefix ~/.local @openai/codex@${version}`;

const agentFindings = (node: string, rawAgent: AgentObservation, latest: Latest, policy: Policy = { kind: "track" }): Array<Finding> => {
  const agent = { ...rawAgent, onPath: rawAgent.onPath.filter((p) => !isSessionShim(p)) };
  const out: Array<Finding> = [];
  const how = AGENT_INSTALL[agent.name];
  if (agent.managedVersion === null) {
    out.push({
      node,
      severity: "error",
      area: "agents",
      key: `${agent.name}-missing`,
        title: `${agent.name} is not installed at ${tilde(agent.managedPath)}`,
      fix: { command: how.install, safe: true },
    });
    return out;
  }
  if (policy.kind === "pin" && agent.managedVersion !== policy.version) {
    out.push({
      node,
      key: `${agent.name}-off-pin`,
      severity: "warn",
      area: "agents",
      title: `${agent.name} ${agent.managedVersion} is not the pinned ${policy.version}`,
      fix: { command: pinCommand(agent.name, policy.version), safe: true },
    });
  }
  const newest = latest.agents[agent.name];
  if (policy.kind === "track" && newest !== null && newest !== agent.managedVersion) {
    out.push({
      node,
      severity: "warn",
      area: "agents",
      key: `${agent.name}-behind`,
        title: `${agent.name} ${agent.managedVersion} is behind ${newest}`,
      fix: { command: how.upgrade, safe: true },
    });
  }
  const first = agent.onPath[0];
  if (first !== undefined && first !== agent.managedPath) {
    out.push({
      node,
      severity: "warn",
      area: "agents",
      key: `${agent.name}-shell-copy`,
        title: `your shell runs ${tilde(first)}, not the managed ${agent.name}`,
      detail: `${tilde(first)} comes before ${tilde(agent.managedPath)} on PATH; upgrades of the managed copy will not reach it`,
    });
  }
  const extra = agent.onPath.filter((p) => p !== agent.managedPath && p !== first);
  if (extra.length > 0) {
    out.push({
      node,
      severity: "info",
      area: "agents",
      key: `${agent.name}-other-copies`,
        title: `other ${agent.name} copies: ${extra.map(tilde).join(", ")}`,
    });
  }
  return out;
};

const providerFindings = (node: string, obs: MachineObservation, proxy: ProxySettings | undefined): Array<Finding> => {
  const out: Array<Finding> = [];
  const serverOnPath = obs.t3.serverPath !== null;
  for (const p of obs.t3.providers) {
    if (!p.enabled) continue;
    if (!p.launch.ok) {
      out.push({
        node,
        severity: "error",
        area: "providers",
        key: `${providerLabel(p.instanceId)}-fails-in-t3`,
        title: `${providerLabel(p.instanceId)} will not start in T3`,
        detail: p.launch.detail + (serverOnPath ? "" : " (checked with the login PATH)"),
      });
      continue;
    }
    // T3 starts something; is it the copy fleet keeps current?
    const agentName = DRIVER_AGENT[p.driver];
    const agent = obs.agents.find((a) => a.name === agentName);
    if (agent !== undefined && p.resolved !== null && !viaLauncher(proxy, p.instanceId, p.resolved) && p.resolved !== agent.managedPath) {
      out.push({
        node,
        severity: "warn",
        area: "providers",
        key: `${providerLabel(p.instanceId)}-not-managed-in-t3`,
        title: `T3 runs ${providerLabel(p.instanceId)} from ${tilde(p.resolved)}, not the managed ${agent.name}`,
        detail: `upgrades of ${tilde(agent.managedPath)} never reach T3 here${
          p.launch.version && agent.managedVersion && p.launch.version !== agent.managedVersion
            ? ` (T3 gets ${p.launch.version}, managed is ${agent.managedVersion})`
            : ""
        }`,
      });
    }
  }
  return out;
};

/** The release channel a node's T3 should follow, from `[t3] channel`; null means "whatever it is on". */
const channelOf = (settings: unknown): string | null => {
  const raw = (settings as { t3?: { channel?: unknown } } | undefined)?.t3?.channel;
  return typeof raw === "string" ? raw : null;
};

const t3Findings = (node: string, obs: MachineObservation, latest: Latest, wantChannel: string | null = null): Array<Finding> => {
  const out: Array<Finding> = [];
  const t3 = obs.t3;
  if (t3.runtime === null && t3.problems.length === 0) {
    out.push({ node, key: "t3-not-installed", severity: "info", area: "t3", title: "T3 Code has never run here" });
    return out;
  }
  t3.problems.forEach((problem, i) => out.push({ node, key: `t3-problem-${i + 1}`, severity: "warn", area: "t3", title: problem }));
  const version = t3.descriptor?.serverVersion ?? t3.installedVersion;
  if (version !== null && wantChannel !== null && cliReleaseChannelOf(version) !== wantChannel) {
    out.push({
      node,
      key: "t3-wrong-channel",
      severity: "warn",
      area: "t3",
      title: `T3 is on ${cliReleaseChannelOf(version)}, but this machine should follow ${wantChannel}`,
      ...(t3.runtimeBinary !== null
        ? {
            fix: {
              command: `${tilde(t3.runtimeBinary)} update --channel ${wantChannel} --allow-downgrade --yes`,
              safe: false,
              disrupts: `restarts the T3 server on ${node}; threads running there stop`,
            },
          }
        : { detail: `install T3 Code's ${wantChannel} desktop app` }),
    });
    return out;
  }
  if (version !== null) {
    const { behind, newest } = releasesBehind(latest, version);
    if (newest !== null && newest !== version) {
      // Nightlies ship several times a day; a build from yesterday is current
      // enough. Lag becomes a warning at two days or five releases.
      const days = releaseDay(newest) !== null && releaseDay(version) !== null
        ? ((releaseDay(newest) ?? 0) - (releaseDay(version) ?? 0)) / 86_400_000
        : null;
      const severity: Severity = (behind !== null && behind >= 5) || (days !== null && days >= 2) || (behind === null && days === null)
        ? "warn"
        : "info";
      const channel = cliReleaseChannelOf(version);
      const how = t3.runtimeBinary !== null
        ? {
            command: `${tilde(t3.runtimeBinary)} update --channel ${channel} --yes`,
            safe: false,
            disrupts: `restarts the T3 server on ${node}; threads running there stop`,
          }
        : undefined;
      out.push({
        node,
        key: "t3-behind",
        severity,
        area: "t3",
        title: `T3 is ${behind === null ? "behind" : `${behind} ${channel} release${behind === 1 ? "" : "s"} behind`} (${versionPair(version, newest)})`,
        ...(how === undefined ? { detail: "the desktop app updates itself; restart it to apply a downloaded update" } : { fix: how }),
      });
    }
  }
  return out;
};

const syncFindings = (node: string, obs: MachineObservation): Array<Finding> => {
  const sync = obs.legacySync;
  if (sync === null) return [];
  const out: Array<Finding> = [];
  if (sync.streak >= 3) {
    out.push({ node, key: "sync-failing", severity: "error", area: "sync", title: `fleet sync failed ${sync.streak} times in a row`, detail: sync.message });
  } else if (sync.result !== "ok") {
    out.push({ node, key: "sync-failed", severity: "warn", area: "sync", title: "last fleet sync failed", detail: sync.message });
  }
  const ageMinutes = Math.round((obs.observedAt / 1000 - sync.when) / 60);
  if (ageMinutes > 60) {
    out.push({ node, key: "sync-stale", severity: "warn", area: "sync", title: `no fleet sync for ${ageMinutes} minutes`, detail: "is the sync timer running?" });
  }
  return out;
};

/**
 * Differences between machines that are each fine on their own: a provider
 * enabled on some machines only, or launched through the proxy launcher on
 * some and directly on others.
 */
const parityFindings = (
  observed: ReadonlyArray<{ name: string; obs: MachineObservation }>,
  proxy: ProxySettings | undefined,
): Array<Finding> => {
  const out: Array<Finding> = [];
  if (observed.length < 2) return out;
  const instanceIds = [...new Set(observed.flatMap((o) => o.obs.t3.providers.map((p) => p.instanceId)))].sort();
  for (const id of instanceIds) {
    const per = observed.map((o) => ({ name: o.name, p: o.obs.t3.providers.find((x) => x.instanceId === id) }));
    const enabled = per.filter((x) => x.p?.enabled).map((x) => x.name);
    const disabled = per.filter((x) => x.p !== undefined && !x.p.enabled).map((x) => x.name);
    if (enabled.length > 0 && disabled.length > 0) {
      for (const name of disabled) {
        out.push({
          node: name,
          severity: "warn",
          area: "parity",
          key: `${providerLabel(id)}-off-here`,
          title: `${providerLabel(id)} is off here but on in ${enabled.join(", ")}`,
        });
      }
    }
    if (proxy?.launchers[id] === undefined) continue;
    const launcherStyle = (p: ProviderObservation | undefined) =>
      p === undefined || !p.enabled || p.binaryPath === null ? null : viaLauncher(proxy, id, p.binaryPath) ? "launcher" : "direct";
    const routed = per.filter((x) => launcherStyle(x.p) === "launcher").map((x) => x.name);
    const direct = per.filter((x) => launcherStyle(x.p) === "direct").map((x) => x.name);
    if (routed.length > 0 && direct.length > 0) {
      for (const name of direct) {
        const obs = observed.find((o) => o.name === name)?.obs;
        const label = providerLabel(id);
        out.push({
          node: name,
          severity: "warn",
          area: "parity",
          key: `${label}-skips-launcher`,
          title: `${label} starts directly here, but through the proxy launcher in ${routed.join(", ")}`,
          ...(obs === undefined ? {} : launcherSwitch(id, obs, proxy)),
        });
      }
    }
  }
  return out;
};

/**
 * How to move one provider onto its proxy launcher, or what stands in the
 * way. The switch is only offered once the proxy has accepted this machine's
 * key: pointing T3 at a launcher whose key is rejected would turn a working
 * provider into a broken one. Commands and hints come from the user's config.
 */
const launcherSwitch = (instanceId: string, obs: MachineObservation, proxy: ProxySettings): { detail: string; fix?: Fix } => {
  const seen = obs.proxy;
  const launcher = proxy.launchers[instanceId] ?? "";
  if (seen === null || (seen.launchers[instanceId] ?? null) === null) {
    return { detail: `the launcher ${launcher} is not installed on this machine` };
  }
  if (!seen.credentials) {
    return { detail: `this machine has no proxy key at ${proxy.credentials}${proxy.missing_key_hint ? `: ${proxy.missing_key_hint}` : ""}` };
  }
  if (seen.key !== "accepted") {
    return {
      detail:
        seen.key === "rejected"
          ? `the proxy rejects this machine's key${proxy.rejected_hint ? `: ${proxy.rejected_hint}` : ""}`
          : `the proxy check failed: ${seen.key}`,
    };
  }
  const detail = "the launcher is installed and the proxy accepts this machine's key; sessions already running keep their launcher";
  return proxy.enable === undefined
    ? { detail: `${detail}. Set T3's ${providerLabel(instanceId)} binary path to ${launcher}` }
    : { detail, fix: { command: proxy.enable.replaceAll("{provider}", instanceId), safe: false } };
};

/** A machine whose T3 goes through the proxy, with a key the proxy refuses: every model call fails there. */
const proxyFindings = (node: string, obs: MachineObservation, proxy: ProxySettings | undefined): Array<Finding> => {
  const routed = obs.t3.providers.filter((p) => p.enabled && viaLauncher(proxy, p.instanceId, p.binaryPath));
  if (routed.length === 0 || obs.proxy?.key === "accepted") return [];
  const names = routed.map((p) => providerLabel(p.instanceId)).join(" and ");
  const why = !obs.proxy?.credentials
    ? "this machine has no proxy key"
    : obs.proxy.key === "rejected"
      ? "the proxy rejects this machine's key"
      : `the proxy check failed (${obs.proxy.key})`;
  return [
    {
      node,
      key: "proxy-key-refused",
      severity: "error",
      area: "providers",
      title: `${names} in T3 cannot reach any model: ${why}`,
      ...(obs.proxy?.key === "rejected" && proxy?.rejected_hint ? { detail: proxy.rejected_hint } : {}),
    },
  ];
};

const RANK: Readonly<Record<Severity, number>> = { error: 0, warn: 1, info: 2 };

/** Every registered area's findings, each area seeing all nodes' facts. */
const areaFindings = (
  observed: ReadonlyArray<{ name: string; obs: MachineObservation }>,
  nodes: ReadonlyArray<Node>,
  areas: ReadonlyArray<AnyArea>,
): Array<Finding> => {
  const out: Array<Finding> = [];
  for (const o of observed) {
    const plugins = o.obs.areas["_plugins"] as { problems?: ReadonlyArray<string> } | undefined;
    for (const [i, problem] of (plugins?.problems ?? []).entries()) {
      out.push({ node: o.name, key: `plugin-problem-${i + 1}`, severity: "error", area: "plugins", title: problem });
    }
  }
  for (const area of areas) {
    const fleet: Array<{ node: string; desired: unknown; observed: unknown }> = [];
    for (const o of observed) {
      const raw = o.obs.areas[area.id];
      const settings = nodes.find((n) => n.name === o.name)?.settings.table[area.id];
      if (raw !== null && typeof raw === "object" && "invalidSettings" in raw) {
        out.push({ node: o.name, key: `${area.id}-settings-invalid`, severity: "error", area: area.id, title: `the [${area.id}] settings for this machine are not valid` });
        continue;
      }
      const decodedObserved = Schema.decodeUnknownOption(area.observed)(raw);
      const decodedDesired = Schema.decodeUnknownOption(area.desired)(settings as unknown);
      if (Option.isNone(decodedObserved) || Option.isNone(decodedDesired)) continue;
      fleet.push({ node: o.name, desired: decodedDesired.value, observed: decodedObserved.value });
    }
    const authority = nodes.find((n) => n.roles.includes("authority"))?.name ?? null;
    for (const entry of fleet) {
      out.push(...area.diagnose({ node: entry.node, desired: entry.desired, observed: entry.observed, fleet, authority }));
    }
  }
  return out;
};

export const diagnose = (
  results: ReadonlyArray<NodeResult>,
  latest: Latest,
  settings: FleetSettings = {},
  nodes: ReadonlyArray<Node> = [],
  areas: ReadonlyArray<AnyArea> = AREAS,
): Array<Finding> => {
  const proxy = settings.proxy;
  const findings: Array<Finding> = [];
  const observed: Array<{ name: string; obs: MachineObservation }> = [];
  for (const r of results) {
    if (!r.ok) {
      findings.push({ node: r.node.name, key: "unreachable", severity: "error", area: "reach", title: "could not observe this machine", detail: r.error });
      continue;
    }
    observed.push({ name: r.node.name, obs: r.observation });
    const nodeSettings = nodes.find((n) => n.name === r.node.name)?.settings.table;
    for (const agent of r.observation.agents) {
      findings.push(...agentFindings(r.node.name, agent, latest, policyOf(nodeSettings, agent.name)));
    }
    findings.push(...t3Findings(r.node.name, r.observation, latest, channelOf(nodeSettings)));
    findings.push(...providerFindings(r.node.name, r.observation, proxy));
    findings.push(...proxyFindings(r.node.name, r.observation, proxy));
    findings.push(...syncFindings(r.node.name, r.observation));
  }
  findings.push(...parityFindings(observed, proxy));
  findings.push(...areaFindings(observed, nodes, areas));
  return findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.node.localeCompare(b.node));
};
