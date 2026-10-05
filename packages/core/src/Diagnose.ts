/**
 * Turning observations into findings. This is where T3 Fleet decides what
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
import { why } from "./Plugins.ts";
import type { FleetSettings, Node, ProxySettings } from "./Config.ts";
import type { Latest } from "./Latest.ts";
import { releasesBehind } from "./Latest.ts";
import { RENEW_WITHIN_MS } from "./T3Access.ts";
import type { AgentObservation, MachineObservation, ProviderObservation } from "./Observation.ts";
import type { NodeResult } from "./Remote.ts";
import { cliReleaseChannelOf } from "./vendor/t3/cliRelease.ts";
import { isLauncher } from "./Names.ts";

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
const DRIVER_AGENT: Readonly<Record<string, "claude" | "codex">> = {
  claudeAgent: "claude",
  codex: "codex",
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether T3 starts this provider through the proxy launcher the config declares for it. */
const viaLauncher = (
  proxy: ProxySettings | undefined,
  instanceId: string,
  binaryPath: string | null,
) => {
  const launcher = proxy?.launchers[instanceId];
  return (
    launcher !== undefined && binaryPath !== null && basename(binaryPath) === basename(launcher)
  );
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
export const providerLabel = (instanceId: string) =>
  instanceId === "claudeAgent" ? "claude" : instanceId;

const tilde = (path: string) =>
  path.replace(/^\/(Users|home)\/[^/]+\//, "~/").replace(/^\/root\//, "~/");

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
type Policy =
  | { readonly kind: "track" }
  | { readonly kind: "pin"; readonly version: string }
  | { readonly kind: "manual" };

const policyOf = (settings: unknown, agent: string): Policy => {
  const raw = (settings as { agents?: Record<string, { policy?: unknown }> } | undefined)?.agents?.[
    agent
  ]?.policy;
  if (raw === "manual") return { kind: "manual" };
  if (typeof raw === "string" && raw.startsWith("pin:"))
    return { kind: "pin", version: raw.slice(4) };
  return { kind: "track" };
};

const pinCommand = (agent: "claude" | "codex", version: string) =>
  agent === "claude"
    ? `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`
    : `npm install -g --prefix ~/.local @openai/codex@${version}`;

/**
 * The copy of an agent a node keeps: the managed one, unless Nix installed it
 * (there, or in place of it). Nix keeps a Nix copy's version, so T3 Fleet
 * never installs or upgrades over it: that would fight the Nix configuration.
 */
export const keptCopy = (agent: AgentObservation) => {
  const nix = agent.nix;
  return nix !== undefined && (agent.managedVersion === null || nix.path === agent.managedPath)
    ? { path: nix.path, version: nix.version, fromNix: true, label: `${agent.name} from Nix` }
    : {
        path: agent.managedPath,
        version: agent.managedVersion,
        fromNix: false,
        label: `managed ${agent.name}`,
      };
};

const agentFindings = (
  node: string,
  rawAgent: AgentObservation,
  latest: Latest,
  policy: Policy = { kind: "track" },
): Array<Finding> => {
  const agent = { ...rawAgent, onPath: rawAgent.onPath.filter((p) => !isSessionShim(p)) };
  const out: Array<Finding> = [];
  const how = AGENT_INSTALL[agent.name];
  const kept = keptCopy(agent);
  const inNix = (what: string) =>
    `it comes from Nix (${tilde(kept.path)}); ${what} it in your Nix configuration`;
  if (!kept.fromNix && agent.managedVersion === null) {
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
  // A Nix copy whose version could not be read has nothing to compare; its path still counts.
  const version = kept.version;
  if (version !== null && policy.kind === "pin" && version !== policy.version) {
    out.push({
      node,
      key: `${agent.name}-off-pin`,
      severity: "warn",
      area: "agents",
      title: `${agent.name} ${version} is not the pinned ${policy.version}`,
      ...(kept.fromNix
        ? { detail: inNix("pin") }
        : { fix: { command: pinCommand(agent.name, policy.version), safe: true } }),
    });
  }
  const newest = latest.agents[agent.name];
  const failed = latest.failed?.[agent.name];
  if (version !== null && policy.kind === "track" && newest === null && failed !== undefined) {
    out.push({
      node,
      severity: "info",
      area: "agents",
      key: `${agent.name}-latest-unknown`,
      title: `could not look up the newest ${agent.name}, so whether ${version} is current is unknown`,
      detail: failed,
    });
  }
  if (version !== null && policy.kind === "track" && newest !== null && newest !== version) {
    out.push({
      node,
      // nixpkgs trails the agents' releases by design; a Nix copy behind is a note, not a problem.
      severity: kept.fromNix ? "info" : "warn",
      area: "agents",
      key: `${agent.name}-behind`,
      title: `${agent.name} ${version} is behind ${newest}`,
      ...(kept.fromNix
        ? { detail: inNix("update") }
        : { fix: { command: how.upgrade, safe: true } }),
    });
  }
  const first = agent.onPath[0];
  if (first !== undefined && first !== kept.path) {
    out.push({
      node,
      severity: "warn",
      area: "agents",
      key: `${agent.name}-shell-copy`,
      title: `your shell runs ${tilde(first)}, not the ${kept.label}`,
      detail: `${tilde(first)} comes before ${tilde(kept.path)} on PATH; upgrades of the ${kept.fromNix ? "Nix" : "managed"} copy will not reach it`,
    });
  }
  const extra = agent.onPath.filter((p) => p !== kept.path && p !== first);
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

const providerFindings = (
  node: string,
  obs: MachineObservation,
  proxy: ProxySettings | undefined,
): Array<Finding> => {
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
    // A t3-fleet models launcher (t3-fleet-claude, t3-fleet-codex, …) runs the managed CLI itself.
    const viaModels = p.resolved !== null && isLauncher(basename(p.resolved));
    const kept = agent === undefined ? undefined : keptCopy(agent);
    if (
      agent !== undefined &&
      kept !== undefined &&
      p.resolved !== null &&
      !viaLauncher(proxy, p.instanceId, p.resolved) &&
      !viaModels &&
      p.resolved !== kept.path &&
      // Another profile's link to the Nix-installed agent (/etc/profiles/per-user, say), at the same version.
      !(
        kept.fromNix &&
        p.resolvedFromNix === true &&
        (p.launch.version === null || kept.version === null || p.launch.version === kept.version)
      )
    ) {
      out.push({
        node,
        severity: "warn",
        area: "providers",
        key: `${providerLabel(p.instanceId)}-not-managed-in-t3`,
        title: `T3 runs ${providerLabel(p.instanceId)} from ${tilde(p.resolved)}, not the ${kept.label}`,
        detail: `upgrades of ${tilde(kept.path)} never reach T3 here${
          p.launch.version && kept.version && p.launch.version !== kept.version
            ? ` (T3 gets ${p.launch.version}, ${kept.fromNix ? "Nix has" : "managed is"} ${kept.version})`
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

/** How a node's T3 is kept current, from `[t3] update`: "when-idle" lets sync update it when no thread runs. */
const updateOf = (settings: unknown): "manual" | "when-idle" =>
  (settings as { t3?: { update?: unknown } } | undefined)?.t3?.update === "when-idle"
    ? "when-idle"
    : "manual";

/** A problem as an older probe reported it, text only; its kind is read from the text. */
const legacyProblem = (title: string): { kind: string; title: string } => ({
  kind: /did not answer/.test(title)
    ? "no-descriptor"
    : /environment/.test(title)
      ? "env-unreadable"
      : /not running/.test(title)
        ? "not-running"
        : /server-runtime\.json/.test(title)
          ? "runtime-unreadable"
          : /settings\.json/.test(title)
            ? "settings-unrecognized"
            : "problem",
  title,
});

const t3Findings = (
  node: string,
  obs: MachineObservation,
  latest: Latest,
  wantChannel: string | null = null,
  update: "manual" | "when-idle" = "manual",
): Array<Finding> => {
  const out: Array<Finding> = [];
  const t3 = obs.t3;
  if (t3.runtime === null && t3.problems.length === 0) {
    out.push({
      node,
      key: "t3-not-installed",
      severity: "info",
      area: "t3",
      title: "T3 Code has never run here",
    });
    return out;
  }
  for (const problem of t3.problems) {
    const { kind, title } = typeof problem === "string" ? legacyProblem(problem) : problem;
    out.push({ node, key: `t3-${kind}`, severity: "warn", area: "t3", title });
  }
  // A CLI-installed server not under its service manager stops with the session that started it.
  if (
    t3.runtime !== null &&
    t3.runtime.alive &&
    t3.runtimeBinary !== null &&
    !t3.runtime.serviceManaged
  ) {
    out.push({
      node,
      key: "t3-not-a-service",
      severity: "warn",
      area: "t3",
      title:
        "the T3 server is not running as a background service; it stops with the session that started it",
      fix: {
        command: `${tilde(t3.runtimeBinary)} service install`,
        safe: false,
        disrupts: `restarts the T3 server on ${node}`,
      },
    });
  }
  const version = t3.descriptor?.serverVersion ?? t3.installedVersion;
  if (version !== null && wantChannel !== null && cliReleaseChannelOf(version) !== wantChannel) {
    out.push({
      node,
      key: "t3-wrong-channel",
      severity: "warn",
      area: "t3",
      title: `T3 is on ${cliReleaseChannelOf(version)}, but this machine should follow ${wantChannel}`,
      ...(t3.fromNix === true
        ? {
            detail: `T3 comes from Nix here; switch it to ${wantChannel} in your Nix configuration`,
          }
        : t3.runtimeBinary !== null
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
    if (newest === null && latest.failed?.t3 !== undefined) {
      out.push({
        node,
        key: "t3-latest-unknown",
        severity: "info",
        area: "t3",
        title: `could not look up T3's newest ${cliReleaseChannelOf(version)} release, so whether ${shortT3(version)} is current is unknown`,
        detail: latest.failed.t3,
      });
    }
    if (newest !== null && newest !== version) {
      // Nightlies ship several times a day; a build from yesterday is current
      // enough. Lag becomes a warning at two days or five releases.
      const days =
        releaseDay(newest) !== null && releaseDay(version) !== null
          ? ((releaseDay(newest) ?? 0) - (releaseDay(version) ?? 0)) / 86_400_000
          : null;
      const severity: Severity =
        (behind !== null && behind >= 5) ||
        (days !== null && days >= 2) ||
        (behind === null && days === null)
          ? "warn"
          : "info";
      const channel = cliReleaseChannelOf(version);
      // When idle, sync updates it itself: the command waits while a thread runs.
      const idle =
        update === "when-idle" && t3.fromNix !== true
          ? {
              command: "t3-fleet t3 update --if-idle",
              safe: true,
            }
          : undefined;
      const how =
        idle ??
        (t3.runtimeBinary !== null
          ? {
              command: `${tilde(t3.runtimeBinary)} update --channel ${channel} --yes`,
              safe: false,
              disrupts: `restarts the T3 server on ${node}; threads running there stop`,
            }
          : undefined);
      out.push({
        node,
        key: "t3-behind",
        severity,
        area: "t3",
        title: `T3 is ${behind === null ? "behind" : `${behind} ${channel} release${behind === 1 ? "" : "s"} behind`} (${versionPair(version, newest)})`,
        ...(t3.fromNix === true
          ? { detail: "T3 comes from Nix here; update it in your Nix configuration" }
          : idle !== undefined
            ? { detail: "sync updates it when no thread is running here", fix: idle }
            : how === undefined
              ? {
                  detail:
                    'the desktop app updates when asked in its UI; [t3] update = "when-idle" lets sync do it',
                }
              : { fix: how }),
      });
    }
  }
  return out;
};

/** How often a node's timer runs `t3-fleet sync`, from `[engine] interval` (seconds; 900 by default, as in the engine area). */
const syncIntervalOf = (settings: unknown): number => {
  const raw = (settings as { engine?: { interval?: unknown } } | undefined)?.engine?.interval;
  return typeof raw === "number" && raw > 0 ? raw : 900;
};

/** A sync is stale once four runs in a row have been missed. */
const syncFindings = (node: string, obs: MachineObservation, interval = 900): Array<Finding> => {
  const sync = obs.lastSync;
  if (sync === null) return [];
  const out: Array<Finding> = [];
  if (sync.streak >= 3) {
    out.push({
      node,
      key: "sync-failing",
      severity: "error",
      area: "sync",
      title: `fleet sync failed ${sync.streak} times in a row`,
      detail: sync.message,
    });
  } else if (sync.result !== "ok") {
    out.push({
      node,
      key: "sync-failed",
      severity: "warn",
      area: "sync",
      title: "last fleet sync failed",
      detail: sync.message,
    });
  }
  const ageMinutes = Math.round((obs.observedAt / 1000 - sync.when) / 60);
  if (ageMinutes > (4 * interval) / 60) {
    const every =
      interval % 60 === 0
        ? `${interval / 60} minute${interval === 60 ? "" : "s"}`
        : `${interval} seconds`;
    out.push({
      node,
      key: "sync-stale",
      severity: "warn",
      area: "sync",
      title: `no fleet sync for ${ageMinutes} minutes`,
      detail: `it should run every ${every}; is the sync timer running?`,
    });
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
  // T3's apps (desktop, web, phone) speak one client protocol and refuse a server
  // on another, showing "Client not supported". Machines on different protocols
  // cannot all be reached from the same app.
  const protocols = observed.flatMap((o) =>
    o.obs.t3.descriptor?.protocol === undefined
      ? []
      : [{ name: o.name, protocol: o.obs.t3.descriptor.protocol }],
  );
  const newest = Math.max(...protocols.map((p) => p.protocol));
  const onNewest = protocols.filter((p) => p.protocol === newest).map((p) => p.name);
  for (const p of protocols.filter((x) => x.protocol < newest)) {
    out.push({
      node: p.name,
      severity: "warn",
      area: "parity",
      key: "t3-protocol-behind",
      title: `T3 here speaks client protocol ${p.protocol}; ${onNewest.join(", ")} speak ${newest}`,
      detail:
        'an app that connects to one side shows the other as "Client not supported"; update T3 here, or update the apps',
    });
  }
  const instanceIds = [
    ...new Set(observed.flatMap((o) => o.obs.t3.providers.map((p) => p.instanceId))),
  ].sort();
  for (const id of instanceIds) {
    const per = observed.map((o) => ({
      name: o.name,
      p: o.obs.t3.providers.find((x) => x.instanceId === id),
    }));
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
      p === undefined || !p.enabled || p.binaryPath === null
        ? null
        : viaLauncher(proxy, id, p.binaryPath)
          ? "launcher"
          : "direct";
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
const launcherSwitch = (
  instanceId: string,
  obs: MachineObservation,
  proxy: ProxySettings,
): { detail: string; fix?: Fix } => {
  const seen = obs.proxy;
  const launcher = proxy.launchers[instanceId] ?? "";
  if (seen === null || (seen.launchers[instanceId] ?? null) === null) {
    return { detail: `the launcher ${launcher} is not installed on this machine` };
  }
  if (!seen.credentials) {
    return {
      detail: `this machine has no proxy key at ${proxy.credentials}${proxy.missing_key_hint ? `: ${proxy.missing_key_hint}` : ""}`,
    };
  }
  if (seen.key !== "accepted") {
    return {
      detail:
        seen.key === "rejected"
          ? `the proxy rejects this machine's key${proxy.rejected_hint ? `: ${proxy.rejected_hint}` : ""}`
          : `the proxy check failed: ${seen.key}`,
    };
  }
  const detail =
    "the launcher is installed and the proxy accepts this machine's key; sessions already running keep their launcher";
  return proxy.enable === undefined
    ? { detail: `${detail}. Set T3's ${providerLabel(instanceId)} binary path to ${launcher}` }
    : { detail, fix: { command: proxy.enable.replaceAll("{provider}", instanceId), safe: false } };
};

/** A machine whose T3 goes through the proxy, with a key the proxy refuses: every model call fails there. */
const proxyFindings = (
  node: string,
  obs: MachineObservation,
  proxy: ProxySettings | undefined,
): Array<Finding> => {
  const routed = obs.t3.providers.filter(
    (p) => p.enabled && viaLauncher(proxy, p.instanceId, p.binaryPath),
  );
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
      ...(obs.proxy?.key === "rejected" && proxy?.rejected_hint
        ? { detail: proxy.rejected_hint }
        : {}),
    },
  ];
};

/** What a person does about a logged-out provider, per driver. */
const LOGIN_HELP: Readonly<Record<string, string>> = {
  claudeAgent:
    "run `claude auth login` on this machine. For a login that does not expire, run `claude setup-token` and keep it in the fleet's secrets as CLAUDE_CODE_OAUTH_TOKEN, with [models] on (see the models area)",
  codex: "run `codex login` on this machine",
};

/**
 * Each enabled provider's login and health, as T3 reports it (or, without
 * T3's snapshot, the CLI's status command). A logged-out provider still
 * starts, so the launch check passes and the first sign is a failed turn in
 * T3; that makes it an error. A provider T3 marks as warning or error is
 * reported with T3's own message, unless the launch check already did.
 */
const providerAuthFindings = (node: string, obs: MachineObservation): Array<Finding> => {
  const out: Array<Finding> = [];
  for (const p of obs.providerAuth) {
    if (!p.enabled) continue;
    const label = providerLabel(p.instanceId);
    const launchFailed = obs.t3.providers.some(
      (x) => x.instanceId === p.instanceId && x.enabled && !x.launch.ok,
    );
    if (p.auth === "unauthenticated") {
      out.push({
        node,
        key: `provider-logged-out-${p.instanceId}`,
        severity: "error",
        area: "providers",
        title: `${label} is not logged in for T3; every ${label} turn there fails`,
        detail: `${p.detail}. ${LOGIN_HELP[p.driver] ?? `sign in to ${label} from T3's provider settings on this machine`}`,
      });
    } else if ((p.status === "error" || p.status === "warning") && !launchFailed) {
      out.push({
        node,
        key: `provider-unhealthy-${p.instanceId}`,
        severity: "warn",
        area: "providers",
        title: `T3 reports ${label} as ${p.status === "error" ? "failing" : "degraded"}`,
        detail: p.detail,
      });
    }
  }
  return out;
};

/**
 * T3 Fleet's read-only token for T3's API, which provider health comes from.
 * Without it only Claude and Codex are checked, through their CLIs.
 */
const t3AccessFindings = (node: string, obs: MachineObservation): Array<Finding> => {
  const access = obs.t3.access;
  if (access === null || access.state === "ok") return [];
  // Renewing a token that is running out, or ran out, is what the person did to get it, with the same CLI and scope;
  // sync may do it, at most once a day (each attempt adds a client in T3). A token T3 refused before then waits for a person.
  const renewal =
    access.expiresAt !== null &&
    (access.state === "expiring"
      ? access.expiresAt - obs.observedAt < RENEW_WITHIN_MS
      : access.state === "rejected" && access.expiresAt <= obs.observedAt);
  const recent =
    access.lastAttempt !== undefined && obs.observedAt - access.lastAttempt < 86_400_000;
  const fix: Fix | undefined = access.cli
    ? { command: "t3-fleet t3 connect", safe: renewal && !recent }
    : undefined;
  const how =
    fix === undefined
      ? "; T3's CLI was not found on this machine to issue one"
      : renewal && recent
        ? `; T3 Fleet tried to renew it ${Math.max(1, Math.round((obs.observedAt - (access.lastAttempt ?? 0)) / 3_600_000))} hours ago, and sync tries again a day after that`
        : "";
  const title =
    access.state === "none"
      ? "T3 Fleet cannot read T3's provider status here; only Claude and Codex logins are checked, through their CLIs"
      : access.state === "expiring"
        ? "T3 Fleet's read-only T3 token expires within three days"
        : access.state === "rejected"
          ? "T3 no longer accepts T3 Fleet's read-only token; provider logins fall back to the CLIs"
          : "T3 Fleet could not read T3's provider status this time";
  return [
    {
      node,
      key: "t3-access",
      severity: access.state === "failed" ? "info" : "warn",
      area: "t3",
      title,
      detail: `${access.detail}${how}`,
      ...(fix === undefined || access.state === "failed" ? {} : { fix }),
    },
  ];
};

const RANK: Readonly<Record<Severity, number>> = { error: 0, warn: 1, info: 2 };

/** Every registered area's findings, each area seeing all nodes' facts. One area failing does not stop the others. */
const areaFindings = (
  observed: ReadonlyArray<{ name: string; obs: MachineObservation }>,
  nodes: ReadonlyArray<Node>,
  areas: ReadonlyArray<AnyArea>,
): Array<Finding> => {
  const out: Array<Finding> = [];
  for (const o of observed) {
    const plugins = o.obs.areas["_plugins"] as
      | { problems?: ReadonlyArray<string | { plugin: string; title: string }> }
      | undefined;
    for (const [i, problem] of (plugins?.problems ?? []).entries()) {
      // Older probes sent the text alone, without the plugin's path.
      const { plugin, title } =
        typeof problem === "string" ? { plugin: String(i + 1), title: problem } : problem;
      out.push({
        node: o.name,
        key: `plugin-failed-${plugin}`,
        severity: "error",
        area: "plugins",
        title,
      });
    }
  }
  for (const area of areas) {
    const unreadable = (node: string, why: string, severity: Severity = "error"): Finding => ({
      node,
      key: `${area.id}-unreadable`,
      severity,
      area: area.id,
      title: `the ${area.id} area could not check this machine`,
      detail: why,
    });
    const fleet: Array<{ node: string; desired: unknown; observed: unknown }> = [];
    for (const o of observed) {
      const raw = o.obs.areas[area.id];
      // An area this node's build does not have.
      if (raw === undefined) continue;
      const settings = nodes.find((n) => n.name === o.name)?.settings.table[area.id];
      if (raw !== null && typeof raw === "object" && "invalidSettings" in raw) {
        out.push({
          node: o.name,
          key: `${area.id}-settings-invalid`,
          severity: "error",
          area: area.id,
          title: `the [${area.id}] settings for this machine are not valid`,
        });
        continue;
      }
      if (raw !== null && typeof raw === "object" && "unreadable" in raw) {
        out.push(unreadable(o.name, String(raw.unreadable)));
        continue;
      }
      const decodedDesired = Schema.decodeUnknownOption(area.desired)(settings as unknown);
      if (Option.isNone(decodedDesired)) continue;
      const decodedObserved = Schema.decodeUnknownOption(area.observed)(raw);
      if (Option.isNone(decodedObserved)) {
        out.push(
          raw === null
            ? unreadable(o.name, "what it observed could not be recorded")
            : unreadable(
                o.name,
                "what it observed is not in a form this build reads; does T3 Fleet there run another build?",
                "warn",
              ),
        );
        continue;
      }
      fleet.push({ node: o.name, desired: decodedDesired.value, observed: decodedObserved.value });
    }
    const authority = nodes.find((n) => n.roles.includes("authority"))?.name ?? null;
    for (const entry of fleet) {
      try {
        out.push(
          ...area.diagnose({
            node: entry.node,
            desired: entry.desired,
            observed: entry.observed,
            fleet,
            authority,
          }),
        );
      } catch (error) {
        out.push(unreadable(entry.node, `its diagnosis failed: ${why(error)}`));
      }
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
      findings.push({
        node: r.node.name,
        key: "unreachable",
        severity: "error",
        area: "reach",
        title: "could not observe this machine",
        detail: r.error,
      });
      continue;
    }
    observed.push({ name: r.node.name, obs: r.observation });
    const nodeSettings = nodes.find((n) => n.name === r.node.name)?.settings.table;
    for (const agent of r.observation.agents) {
      findings.push(
        ...agentFindings(r.node.name, agent, latest, policyOf(nodeSettings, agent.name)),
      );
    }
    findings.push(
      ...t3Findings(
        r.node.name,
        r.observation,
        latest,
        channelOf(nodeSettings),
        updateOf(nodeSettings),
      ),
    );
    findings.push(...providerFindings(r.node.name, r.observation, proxy));
    findings.push(...proxyFindings(r.node.name, r.observation, proxy));
    findings.push(...syncFindings(r.node.name, r.observation, syncIntervalOf(nodeSettings)));
    findings.push(...providerAuthFindings(r.node.name, r.observation));
    findings.push(...t3AccessFindings(r.node.name, r.observation));
  }
  findings.push(...parityFindings(observed, proxy));
  findings.push(...areaFindings(observed, nodes, areas));
  return findings.sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.node.localeCompare(b.node),
  );
};
