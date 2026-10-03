import { describe, expect, it } from "vite-plus/test";

import type { FleetSettings } from "./Config.ts";
import { diagnose, type Finding } from "./Diagnose.ts";
import type { Latest } from "./Latest.ts";
import type { MachineObservation, ProviderObservation } from "./Observation.ts";
import { providerPlans } from "./Probe.ts";
import type { NodeResult } from "./Remote.ts";

const latest: Latest = {
  agents: { claude: "2.1.288", codex: "0.160.0" },
  t3: {
    nightly: {
      versions: [
        "0.0.46-nightly.20261003.2632",
        "0.0.46-nightly.20261003.2623",
        "0.0.46-nightly.20261002.2600",
        "0.0.45-nightly.20261001.2500",
        "0.0.45-nightly.20260930.2400",
        "0.0.44-nightly.20260929.2300",
        "0.0.43-nightly.20260927.2344",
      ],
    },
  },
};

const provider = (over: Partial<ProviderObservation> & { instanceId: string }): ProviderObservation => ({
  driver: over.instanceId,
  enabled: true,
  binaryPath: `/home/u/.local/bin/fleet-${over.instanceId === "claudeAgent" ? "claude" : over.instanceId}`,
  resolved: `/home/u/.local/bin/fleet-${over.instanceId === "claudeAgent" ? "claude" : over.instanceId}`,
  launch: { ok: true, version: "1.0.0", detail: "starts" },
  ...over,
});

const machine = (over: Partial<MachineObservation> = {}, t3: Partial<MachineObservation["t3"]> = {}): MachineObservation => ({
  protocol: 5,
  hostname: "h",
  platform: "linux",
  arch: "x64",
  user: "u",
  observedAt: 1_791_000_000_000,
  agents: [
    { name: "claude", managedPath: "/home/u/.local/bin/claude", managedVersion: "2.1.288", onPath: ["/home/u/.local/bin/claude"] },
    { name: "codex", managedPath: "/home/u/.local/bin/codex", managedVersion: "0.160.0", onPath: ["/home/u/.local/bin/codex"] },
  ],
  t3: {
    runtime: { pid: 1, origin: "http://127.0.0.1:3773", serviceManaged: true, alive: true, startedAt: null },
    descriptor: { environmentId: "e", label: "l", serverVersion: "0.0.46-nightly.20261003.2632" },
    installedVersion: "0.0.46-nightly.20261003.2632",
    runtimeBinary: "/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2632/t3",
    serverPath: "/usr/bin:/bin",
    providers: [provider({ instanceId: "claudeAgent" }), provider({ instanceId: "codex" })],
    problems: [],
    ...t3,
  },
  claude: null,
  proxy: {
    launchers: { claudeAgent: "/home/u/.local/bin/fleet-claude", codex: "/home/u/.local/bin/fleet-codex" },
    credentials: true,
    key: "accepted",
  },
  areas: {},
  legacySync: { when: 1_791_000_000, result: "ok", message: "abc", streak: 0 },
  ...over,
});

const ok = (name: string, observation: MachineObservation): NodeResult => ({
  node: { name, ssh: name, roles: ["member"], profiles: [], tailnet: null, settings: { table: {}, provenance: new Map() } },
  ok: true,
  observation,
  ms: 1,
});

/** A user's fleetx.toml declaring a proxy with launchers named fleet-*. */
const settings: FleetSettings = {
  proxy: {
    credentials: "~/.config/proxy.json",
    launchers: { claudeAgent: "~/.local/bin/fleet-claude", codex: "~/.local/bin/fleet-codex" },
    enable: "set-launcher {provider}",
    rejected_hint: "restart the proxy",
  },
};

const titles = (findings: ReadonlyArray<Finding>, severity?: Finding["severity"]) =>
  findings.filter((f) => severity === undefined || f.severity === severity).map((f) => `${f.node}: ${f.title}`);

describe("diagnose", () => {
  it("is quiet when every machine matches and is current", () => {
    expect(diagnose([ok("a", machine()), ok("b", machine())], latest, settings)).toEqual([]);
  });

  it("warns on a T3 server days behind, with a disruptive update fix", () => {
    const old = machine({}, {
      descriptor: { environmentId: "e", label: "l", serverVersion: "0.0.43-nightly.20260927.2344" },
      runtimeBinary: "/home/u/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3",
    });
    const [finding] = diagnose([ok("server", old)], latest, settings);
    expect(finding?.severity).toBe("warn");
    expect(finding?.title).toContain("6 nightly releases behind");
    expect(finding?.fix?.command).toBe("~/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3 update --channel nightly --yes");
    expect(finding?.fix?.safe).toBe(false);
    expect(finding?.fix?.disrupts).toContain("server");
  });

  it("only notes a nightly from the same day", () => {
    const recent = machine({}, { descriptor: { environmentId: "e", label: "l", serverVersion: "0.0.46-nightly.20261003.2623" } });
    expect(titles(diagnose([ok("laptop", recent)], latest, settings), "warn")).toEqual([]);
    expect(titles(diagnose([ok("laptop", recent)], latest, settings), "info")).toHaveLength(1);
  });

  it("flags a provider that will not start under the T3 server's environment", () => {
    const broken = machine({}, {
      providers: [
        provider({ instanceId: "codex", resolved: null, launch: { ok: false, version: null, detail: "codex is not on the T3 server's PATH" } }),
        provider({ instanceId: "claudeAgent" }),
      ],
    });
    const errors = diagnose([ok("server", broken)], latest, settings).filter((f) => f.severity === "error");
    expect(errors.map((f) => f.title)).toEqual(["codex will not start in T3"]);
    expect(errors[0]?.detail).toContain("not on the T3 server's PATH");
  });

  it("notices T3 running a different copy than the managed one", () => {
    const shim = machine({}, {
      providers: [
        provider({ instanceId: "codex", binaryPath: "codex", resolved: "/home/u/.local/share/mise/shims/codex" }),
        provider({ instanceId: "claudeAgent", binaryPath: "claude", resolved: "/home/u/.local/bin/claude" }),
      ],
    });
    expect(titles(diagnose([ok("desktop", shim)], latest, settings), "warn")).toEqual([
      "desktop: T3 runs codex from ~/.local/share/mise/shims/codex, not the managed codex",
    ]);
  });

  it("compares machines: a provider on everywhere but one, or launched differently", () => {
    const direct = machine({}, {
      providers: [
        provider({ instanceId: "codex", binaryPath: "/home/u/.local/bin/codex", resolved: "/home/u/.local/bin/codex" }),
        provider({ instanceId: "claudeAgent", enabled: false }),
      ],
    });
    expect(titles(diagnose([ok("a", machine()), ok("b", machine()), ok("c", direct)], latest, settings), "warn")).toEqual([
      "c: claude is off here but on in a, b",
      "c: codex starts directly here, but through the proxy launcher in a, b",
    ]);
  });

  it("switches a provider to the launcher only once the proxy accepts the key", () => {
    const direct = (key: string | null, credentials = true) =>
      machine(
        { proxy: { launchers: { claudeAgent: "/l/fleet-claude", codex: "/l/fleet-codex" }, credentials, key } },
        {
          providers: [
            provider({ instanceId: "codex", binaryPath: "codex", resolved: "/home/u/.local/bin/codex" }),
            provider({ instanceId: "claudeAgent" }),
          ],
        },
      );
    const switchFor = (obs: MachineObservation) =>
      diagnose([ok("a", machine()), ok("c", obs)], latest, settings).find((f) => f.key === "codex-skips-launcher");
    expect(switchFor(direct("accepted"))?.fix?.command).toBe("set-launcher codex");
    expect(switchFor(direct("rejected"))?.fix).toBeUndefined();
    expect(switchFor(direct("rejected"))?.detail).toContain("restart the proxy");
    expect(switchFor(direct(null, false))?.detail).toContain("no proxy key");
  });

  it("is an error when T3 goes through the proxy with a refused key", () => {
    const refused = machine({ proxy: { launchers: { claudeAgent: "/l/fleet-claude", codex: "/l/fleet-codex" }, credentials: true, key: "rejected" } });
    expect(titles(diagnose([ok("server", refused)], latest, settings), "error")).toEqual([
      "server: claude and codex in T3 cannot reach any model: the proxy rejects this machine's key",
    ]);
  });

  it("offers a safe upgrade for a stale agent and warns when PATH prefers another copy", () => {
    const stale = machine({
      agents: [
        { name: "claude", managedPath: "/home/u/.local/bin/claude", managedVersion: "2.1.281", onPath: ["/home/u/.local/bin/claude"] },
        { name: "codex", managedPath: "/home/u/.local/bin/codex", managedVersion: "0.160.0", onPath: ["/home/u/.vite-plus/bin/codex", "/home/u/.local/bin/codex"] },
      ],
    });
    const findings = diagnose([ok("desktop", stale)], latest, settings);
    const upgrade = findings.find((f) => f.title === "claude 2.1.281 is behind 2.1.288");
    expect(upgrade?.fix).toEqual({ command: "~/.local/bin/claude update", safe: true });
    expect(titles(findings, "warn")).toContain("desktop: your shell runs ~/.vite-plus/bin/codex, not the managed codex");
  });

  it("ignores session wrappers in the temp directory", () => {
    const shimmed = machine({
      agents: [
        { name: "claude", managedPath: "/home/u/.local/bin/claude", managedVersion: "2.1.288", onPath: ["/var/folders/g1/x/T/cmux-cli-shims/1/claude", "/home/u/.local/bin/claude"] },
        { name: "codex", managedPath: "/home/u/.local/bin/codex", managedVersion: "0.160.0", onPath: ["/home/u/.local/bin/codex", "/tmp/cmux-cli-shims/1/codex"] },
      ],
    });
    expect(diagnose([ok("laptop", shimmed)], latest, settings)).toEqual([]);
  });

  it("counts a fleetx models launcher as the managed CLI", () => {
    const routed = machine({}, {
      providers: [
        provider({ instanceId: "claudeAgent", binaryPath: "/home/u/.local/bin/fleetx-claude", resolved: "/home/u/.local/bin/fleetx-claude" }),
        provider({ instanceId: "codex", binaryPath: "/home/u/.local/bin/fleetx-codex", resolved: "/home/u/.local/bin/fleetx-codex" }),
      ],
    });
    expect(diagnose([ok("laptop", routed)], latest, {}).filter((f) => f.area === "providers")).toEqual([]);
  });

  it("reports a machine it could not reach without dropping the others", () => {
    const findings = diagnose(
      [ok("a", machine()), { node: { name: "b", ssh: "b", roles: ["member"], profiles: [], tailnet: null, settings: { table: {}, provenance: new Map() } }, ok: false, error: "ssh b failed: timeout", ms: 1 }],
      latest,
      settings,
    );
    expect(titles(findings)).toEqual(["b: could not observe this machine"]);
  });
});

describe("providerPlans", () => {
  it("applies T3's defaults: codex and claude on, others off", () => {
    const plans = providerPlans({});
    expect(plans.filter((p) => p.enabled).map((p) => [p.instanceId, p.binaryPath])).toEqual([
      ["claudeAgent", "claude"],
      ["codex", "codex"],
    ]);
  });

  it("prefers an instance's binaryPath, then the legacy provider setting", () => {
    const plans = providerPlans({
      providers: { codex: { binaryPath: "/legacy/codex" }, grok: { enabled: true } },
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "/x/fleet-claude" } },
      } as never,
    });
    const byId = Object.fromEntries(plans.map((p) => [p.instanceId, p]));
    expect(byId["claudeAgent"]?.binaryPath).toBe("/x/fleet-claude");
    expect(byId["codex"]?.binaryPath).toBe("/legacy/codex");
    expect(byId["grok"]?.enabled).toBe(true);
  });
});

describe("without a proxy in the config", () => {
  it("does not compare launchers at all", () => {
    const direct = machine({}, {
      providers: [
        provider({ instanceId: "codex", binaryPath: "/home/u/.local/bin/codex", resolved: "/home/u/.local/bin/codex" }),
        provider({ instanceId: "claudeAgent", binaryPath: "/home/u/.local/bin/claude", resolved: "/home/u/.local/bin/claude" }),
      ],
    });
    expect(diagnose([ok("a", direct), ok("c", direct)], latest)).toEqual([]);
  });
});
