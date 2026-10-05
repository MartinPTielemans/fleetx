import { describe, expect, it } from "vite-plus/test";

import type { FleetSettings } from "./Config.ts";
import { diagnose, type Finding } from "./Diagnose.ts";
import type { Latest } from "./Latest.ts";
import type { MachineObservation, ProviderObservation } from "./Observation.ts";
import { providerPlans } from "./Probe.ts";
import { renderStatus } from "./Render.ts";
import { T3_DRIVERS } from "./T3Settings.ts";
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

const provider = (
  over: Partial<ProviderObservation> & { instanceId: string },
): ProviderObservation => ({
  driver: over.instanceId,
  enabled: true,
  binaryPath: `/home/u/.local/bin/fleet-${over.instanceId === "claudeAgent" ? "claude" : over.instanceId}`,
  resolved: `/home/u/.local/bin/fleet-${over.instanceId === "claudeAgent" ? "claude" : over.instanceId}`,
  launch: { ok: true, version: "1.0.0", detail: "starts" },
  ...over,
});

const machine = (
  over: Partial<MachineObservation> = {},
  t3: Partial<MachineObservation["t3"]> = {},
): MachineObservation => ({
  protocol: 5,
  hostname: "h",
  platform: "linux",
  arch: "x64",
  user: "u",
  observedAt: 1_791_000_000_000,
  agents: [
    {
      name: "claude",
      managedPath: "/home/u/.local/bin/claude",
      managedVersion: "2.1.288",
      onPath: ["/home/u/.local/bin/claude"],
    },
    {
      name: "codex",
      managedPath: "/home/u/.local/bin/codex",
      managedVersion: "0.160.0",
      onPath: ["/home/u/.local/bin/codex"],
    },
  ],
  t3: {
    runtime: {
      pid: 1,
      origin: "http://127.0.0.1:3773",
      serviceManaged: true,
      alive: true,
      startedAt: null,
    },
    descriptor: { environmentId: "e", label: "l", serverVersion: "0.0.46-nightly.20261003.2632" },
    installedVersion: "0.0.46-nightly.20261003.2632",
    runtimeBinary: "/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2632/t3",
    serverPath: "/usr/bin:/bin",
    providers: [provider({ instanceId: "claudeAgent" }), provider({ instanceId: "codex" })],
    access: { state: "ok", expiresAt: 1_800_000_000_000, detail: "read from T3", cli: true },
    problems: [],
    ...t3,
  },
  providerAuth: [],
  proxy: {
    launchers: {
      claudeAgent: "/home/u/.local/bin/fleet-claude",
      codex: "/home/u/.local/bin/fleet-codex",
    },
    credentials: true,
    key: "accepted",
  },
  areas: {},
  lastSync: { when: 1_791_000_000, result: "ok", message: "abc", streak: 0 },
  ...over,
});

const ok = (name: string, observation: MachineObservation): NodeResult => ({
  node: {
    name,
    ssh: name,
    roles: ["member"],
    profiles: [],
    tailnet: null,
    settings: { table: {}, provenance: new Map() },
  },
  ok: true,
  observation,
  ms: 1,
});

/** A user's t3-fleet.toml declaring a proxy with launchers named fleet-*. */
const settings: FleetSettings = {
  proxy: {
    credentials: "~/.config/proxy.json",
    launchers: { claudeAgent: "~/.local/bin/fleet-claude", codex: "~/.local/bin/fleet-codex" },
    enable: "set-launcher {provider}",
    rejected_hint: "restart the proxy",
  },
};

const titles = (findings: ReadonlyArray<Finding>, severity?: Finding["severity"]) =>
  findings
    .filter((f) => severity === undefined || f.severity === severity)
    .map((f) => `${f.node}: ${f.title}`);

describe("diagnose", () => {
  it("is quiet when every machine matches and is current", () => {
    expect(diagnose([ok("a", machine()), ok("b", machine())], latest, settings)).toEqual([]);
  });

  it("warns on a T3 server days behind, with a disruptive update fix", () => {
    const old = machine(
      {},
      {
        descriptor: {
          environmentId: "e",
          label: "l",
          serverVersion: "0.0.43-nightly.20260927.2344",
        },
        runtimeBinary: "/home/u/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3",
      },
    );
    const [finding] = diagnose([ok("server", old)], latest, settings);
    expect(finding?.severity).toBe("warn");
    expect(finding?.title).toContain("6 nightly releases behind");
    expect(finding?.fix?.command).toBe(
      "~/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3 update --channel nightly --yes",
    );
    expect(finding?.fix?.safe).toBe(false);
    expect(finding?.fix?.disrupts).toContain("server");
  });

  it("under [t3] update = when-idle, any T3 behind gets the idle-aware update as a safe fix, desktop app too", () => {
    const behind = (runtimeBinary: string | null) =>
      machine(
        {},
        {
          descriptor: {
            environmentId: "e",
            label: "l",
            serverVersion: "0.0.46-nightly.20261003.2623",
          },
          runtimeBinary,
        },
      );
    const result = (name: string, runtimeBinary: string | null) => {
      const r = ok(name, behind(runtimeBinary));
      return {
        ...r,
        node: {
          ...r.node,
          settings: { table: { t3: { update: "when-idle" } }, provenance: new Map() },
        },
      };
    };
    const server = result("server", "/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2623/t3");
    const laptop = result("laptop", null);
    for (const r of [server, laptop]) {
      const finding = diagnose([r], latest, settings, [r.node]).find((f) => f.key === "t3-behind");
      expect(finding?.fix).toEqual({ command: "t3-fleet t3 update --if-idle", safe: true });
      expect(finding?.detail).toContain("no thread is running");
    }
    // Without the setting the desktop app keeps no fix, and says how to get one.
    const manual = diagnose([ok("laptop", behind(null))], latest, settings).find(
      (f) => f.key === "t3-behind",
    );
    expect(manual?.fix).toBeUndefined();
    expect(manual?.detail).toContain('update = "when-idle"');
  });

  it("says when the newest releases could not be looked up, instead of leaving t3-behind out", () => {
    const unknown: Latest = {
      agents: { claude: null, codex: "0.160.0" },
      t3: {},
      failed: { claude: "no answer from registry.npmjs.org", t3: "GitHub's limit is used up" },
    };
    const findings = diagnose([ok("a", machine())], unknown, settings);
    expect(findings.map((f) => [f.key, f.severity, f.detail])).toEqual([
      ["claude-latest-unknown", "info", "no answer from registry.npmjs.org"],
      ["t3-latest-unknown", "info", "GitHub's limit is used up"],
    ]);
  });

  it("warns when machines speak different T3 client protocols", () => {
    const descriptor = (protocol: number) => ({
      environmentId: "e",
      label: "l",
      serverVersion: "0.0.46-nightly.20261003.2632",
      protocol,
    });
    const findings = diagnose(
      [
        ok("a", machine({}, { descriptor: descriptor(2) })),
        ok("b", machine({}, { descriptor: descriptor(1) })),
      ],
      latest,
      settings,
    );
    expect(titles(findings)).toEqual(["b: T3 here speaks client protocol 1; a speak 2"]);
  });

  it("only notes a nightly from the same day", () => {
    const recent = machine(
      {},
      {
        descriptor: {
          environmentId: "e",
          label: "l",
          serverVersion: "0.0.46-nightly.20261003.2623",
        },
      },
    );
    expect(titles(diagnose([ok("laptop", recent)], latest, settings), "warn")).toEqual([]);
    expect(titles(diagnose([ok("laptop", recent)], latest, settings), "info")).toHaveLength(1);
  });

  it("flags a provider that will not start under the T3 server's environment", () => {
    const broken = machine(
      {},
      {
        providers: [
          provider({
            instanceId: "codex",
            resolved: null,
            launch: { ok: false, version: null, detail: "codex is not on the T3 server's PATH" },
          }),
          provider({ instanceId: "claudeAgent" }),
        ],
      },
    );
    const errors = diagnose([ok("server", broken)], latest, settings).filter(
      (f) => f.severity === "error",
    );
    expect(errors.map((f) => f.title)).toEqual(["codex will not start in T3"]);
    expect(errors[0]?.detail).toContain("not on the T3 server's PATH");
  });

  it("notices T3 running a different copy than the managed one", () => {
    const shim = machine(
      {},
      {
        providers: [
          provider({
            instanceId: "codex",
            binaryPath: "codex",
            resolved: "/home/u/.local/share/mise/shims/codex",
          }),
          provider({
            instanceId: "claudeAgent",
            binaryPath: "claude",
            resolved: "/home/u/.local/bin/claude",
          }),
        ],
      },
    );
    expect(titles(diagnose([ok("desktop", shim)], latest, settings), "warn")).toEqual([
      "desktop: T3 runs codex from ~/.local/share/mise/shims/codex, not the managed codex",
    ]);
  });

  it("compares machines: a provider on everywhere but one, or launched differently", () => {
    const direct = machine(
      {},
      {
        providers: [
          provider({
            instanceId: "codex",
            binaryPath: "/home/u/.local/bin/codex",
            resolved: "/home/u/.local/bin/codex",
          }),
          provider({ instanceId: "claudeAgent", enabled: false }),
        ],
      },
    );
    expect(
      titles(
        diagnose([ok("a", machine()), ok("b", machine()), ok("c", direct)], latest, settings),
        "warn",
      ),
    ).toEqual([
      "c: claude is off here but on in a, b",
      "c: codex starts directly here, but through the proxy launcher in a, b",
    ]);
  });

  it("switches a provider to the launcher only once the proxy accepts the key", () => {
    const direct = (key: string | null, credentials = true) =>
      machine(
        {
          proxy: {
            launchers: { claudeAgent: "/l/fleet-claude", codex: "/l/fleet-codex" },
            credentials,
            key,
          },
        },
        {
          providers: [
            provider({
              instanceId: "codex",
              binaryPath: "codex",
              resolved: "/home/u/.local/bin/codex",
            }),
            provider({ instanceId: "claudeAgent" }),
          ],
        },
      );
    const switchFor = (obs: MachineObservation) =>
      diagnose([ok("a", machine()), ok("c", obs)], latest, settings).find(
        (f) => f.key === "codex-skips-launcher",
      );
    expect(switchFor(direct("accepted"))?.fix?.command).toBe("set-launcher codex");
    expect(switchFor(direct("rejected"))?.fix).toBeUndefined();
    expect(switchFor(direct("rejected"))?.detail).toContain("restart the proxy");
    expect(switchFor(direct(null, false))?.detail).toContain("no proxy key");
  });

  it("is an error when T3 goes through the proxy with a refused key", () => {
    const refused = machine({
      proxy: {
        launchers: { claudeAgent: "/l/fleet-claude", codex: "/l/fleet-codex" },
        credentials: true,
        key: "rejected",
      },
    });
    expect(titles(diagnose([ok("server", refused)], latest, settings), "error")).toEqual([
      "server: claude and codex in T3 cannot reach any model: the proxy rejects this machine's key",
    ]);
  });

  it("offers a safe upgrade for a stale agent and warns when PATH prefers another copy", () => {
    const stale = machine({
      agents: [
        {
          name: "claude",
          managedPath: "/home/u/.local/bin/claude",
          managedVersion: "2.1.281",
          onPath: ["/home/u/.local/bin/claude"],
        },
        {
          name: "codex",
          managedPath: "/home/u/.local/bin/codex",
          managedVersion: "0.160.0",
          onPath: ["/home/u/.vite-plus/bin/codex", "/home/u/.local/bin/codex"],
        },
      ],
    });
    const findings = diagnose([ok("desktop", stale)], latest, settings);
    const upgrade = findings.find((f) => f.title === "claude 2.1.281 is behind 2.1.288");
    expect(upgrade?.fix).toEqual({ command: "~/.local/bin/claude update", safe: true });
    expect(titles(findings, "warn")).toContain(
      "desktop: your shell runs ~/.vite-plus/bin/codex, not the managed codex",
    );
  });

  it("ignores session wrappers in the temp directory", () => {
    const shimmed = machine({
      agents: [
        {
          name: "claude",
          managedPath: "/home/u/.local/bin/claude",
          managedVersion: "2.1.288",
          onPath: ["/var/folders/g1/x/T/cmux-cli-shims/1/claude", "/home/u/.local/bin/claude"],
        },
        {
          name: "codex",
          managedPath: "/home/u/.local/bin/codex",
          managedVersion: "0.160.0",
          onPath: ["/home/u/.local/bin/codex", "/tmp/cmux-cli-shims/1/codex"],
        },
      ],
    });
    expect(diagnose([ok("laptop", shimmed)], latest, settings)).toEqual([]);
  });

  it("counts a t3-fleet models launcher as the managed CLI", () => {
    const routed = machine(
      {},
      {
        providers: [
          provider({
            instanceId: "claudeAgent",
            binaryPath: "/home/u/.local/bin/t3-fleet-claude",
            resolved: "/home/u/.local/bin/t3-fleet-claude",
          }),
          provider({
            instanceId: "codex",
            binaryPath: "/home/u/.local/bin/t3-fleet-codex",
            resolved: "/home/u/.local/bin/t3-fleet-codex",
          }),
        ],
      },
    );
    expect(
      diagnose([ok("laptop", routed)], latest, {}).filter((f) => f.area === "providers"),
    ).toEqual([]);
  });

  describe("agents Nix installed", () => {
    const fromNix = (
      claude: Partial<MachineObservation["agents"][number]>,
      providers?: MachineObservation["t3"]["providers"],
    ) =>
      machine(
        {
          agents: [
            {
              name: "claude",
              managedPath: "/home/u/.local/bin/claude",
              managedVersion: null,
              onPath: ["/home/u/.nix-profile/bin/claude"],
              nix: { path: "/home/u/.nix-profile/bin/claude", version: "2.1.288" },
              ...claude,
            },
            machine().agents[1]!,
          ],
        },
        providers === undefined ? {} : { providers },
      );

    it("installs nothing over a current Nix copy, and accepts T3 running it from another profile", () => {
      const nix = fromNix({}, [
        provider({
          instanceId: "claudeAgent",
          binaryPath: "claude",
          resolved: "/etc/profiles/per-user/u/bin/claude",
          resolvedFromNix: true,
          launch: { ok: true, version: "2.1.288", detail: "starts" },
        }),
        provider({ instanceId: "codex" }),
      ]);
      expect(diagnose([ok("nixos", nix)], latest, settings)).toEqual([]);
    });

    it("leaves a Nix copy behind to the Nix configuration: a note with no fix", () => {
      const findings = diagnose(
        [
          ok(
            "nixos",
            fromNix({ nix: { path: "/home/u/.nix-profile/bin/claude", version: "2.1.281" } }),
          ),
        ],
        latest,
        settings,
      );
      expect(findings.map((f) => f.key)).toEqual(["claude-behind"]);
      expect(findings[0]).toMatchObject({
        severity: "info",
        title: "claude 2.1.281 is behind 2.1.288",
      });
      expect(findings[0]?.fix).toBeUndefined();
      expect(findings[0]?.detail).toBe(
        "it comes from Nix (~/.nix-profile/bin/claude); update it in your Nix configuration",
      );
    });

    it("never upgrades the managed path when home-manager links it into the Nix store", () => {
      const linked = fromNix({
        managedVersion: "2.1.281",
        onPath: ["/home/u/.local/bin/claude"],
        nix: { path: "/home/u/.local/bin/claude", version: "2.1.281" },
      });
      const behind = diagnose([ok("nixos", linked)], latest, settings).find(
        (f) => f.key === "claude-behind",
      );
      expect(behind?.fix).toBeUndefined();
    });

    it("still notices a non-Nix copy shadowing it, in PATH or in T3", () => {
      const shadowed = fromNix(
        { onPath: ["/home/u/.npm-global/bin/claude", "/home/u/.nix-profile/bin/claude"] },
        [
          provider({
            instanceId: "claudeAgent",
            binaryPath: "claude",
            resolved: "/home/u/.npm-global/bin/claude",
          }),
          provider({ instanceId: "codex" }),
        ],
      );
      expect(titles(diagnose([ok("nixos", shadowed)], latest, settings), "warn")).toEqual([
        "nixos: your shell runs ~/.npm-global/bin/claude, not the claude from Nix",
        "nixos: T3 runs claude from ~/.npm-global/bin/claude, not the claude from Nix",
      ]);
    });

    it("still flags T3 running another Nix profile's copy at a different version", () => {
      const stale = fromNix({}, [
        provider({
          instanceId: "claudeAgent",
          binaryPath: "claude",
          resolved: "/etc/profiles/per-user/u/bin/claude",
          resolvedFromNix: true,
          launch: { ok: true, version: "2.1.270", detail: "starts" },
        }),
        provider({ instanceId: "codex" }),
      ]);
      expect(titles(diagnose([ok("nixos", stale)], latest, settings), "warn")).toEqual([
        "nixos: T3 runs claude from /etc/profiles/per-user/u/bin/claude, not the claude from Nix",
      ]);
    });

    it("checks PATH even when the Nix copy's version is unreadable", () => {
      const unreadable = fromNix({
        onPath: ["/home/u/.npm-global/bin/claude", "/home/u/.nix-profile/bin/claude"],
        nix: { path: "/home/u/.nix-profile/bin/claude", version: null },
      });
      expect(titles(diagnose([ok("nixos", unreadable)], latest, settings))).toEqual([
        "nixos: your shell runs ~/.npm-global/bin/claude, not the claude from Nix",
      ]);
    });

    it("says a pin is set in the Nix configuration instead of reinstalling", () => {
      const r = ok("nixos", fromNix({}));
      const pinned = {
        ...r,
        node: {
          ...r.node,
          settings: {
            table: { agents: { claude: { policy: "pin:2.1.280" } } },
            provenance: new Map(),
          },
        },
      };
      const off = diagnose([pinned], latest, settings, [pinned.node]).find(
        (f) => f.key === "claude-off-pin",
      );
      expect(off?.fix).toBeUndefined();
      expect(off?.detail).toContain("pin it in your Nix configuration");
    });
  });

  it("leaves a T3 that Nix installed to Nix, even under [t3] update = when-idle", () => {
    const r = ok(
      "nixos",
      machine(
        {},
        {
          descriptor: {
            environmentId: "e",
            label: "l",
            serverVersion: "0.0.46-nightly.20261001.2500",
          },
          runtimeBinary: null,
          fromNix: true,
        },
      ),
    );
    const idle = {
      ...r,
      node: {
        ...r.node,
        settings: { table: { t3: { update: "when-idle" } }, provenance: new Map() },
      },
    };
    const behind = diagnose([idle], latest, settings, [idle.node]).find(
      (f) => f.key === "t3-behind",
    );
    expect(behind?.fix).toBeUndefined();
    expect(behind?.detail).toBe("T3 comes from Nix here; update it in your Nix configuration");
  });

  it("reports a machine it could not reach without dropping the others", () => {
    const findings = diagnose(
      [
        ok("a", machine()),
        {
          node: {
            name: "b",
            ssh: "b",
            roles: ["member"],
            profiles: [],
            tailnet: null,
            settings: { table: {}, provenance: new Map() },
          },
          ok: false,
          error: "ssh b failed: timeout",
          ms: 1,
        },
      ],
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

  it("takes each driver's defaults from T3's own settings schema", () => {
    expect(T3_DRIVERS).toEqual({
      codex: { enabled: true, bin: "codex" },
      claudeAgent: { enabled: true, bin: "claude" },
      cursor: { enabled: false, bin: null },
      grok: { enabled: false, bin: "grok" },
      pi: { enabled: false, bin: "pi" },
      opencode: { enabled: false, bin: "opencode" },
      antigravity: { enabled: false, bin: null },
    });
  });

  it("prefers an instance's binaryPath, then the legacy provider setting", () => {
    const plans = providerPlans({
      providers: { codex: { binaryPath: "/legacy/codex" }, grok: { enabled: true } },
      providerInstances: {
        claudeAgent: {
          driver: "claudeAgent",
          enabled: true,
          config: { binaryPath: "/x/fleet-claude" },
        },
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
    const direct = machine(
      {},
      {
        providers: [
          provider({
            instanceId: "codex",
            binaryPath: "/home/u/.local/bin/codex",
            resolved: "/home/u/.local/bin/codex",
          }),
          provider({
            instanceId: "claudeAgent",
            binaryPath: "/home/u/.local/bin/claude",
            resolved: "/home/u/.local/bin/claude",
          }),
        ],
      },
    );
    expect(diagnose([ok("a", direct), ok("c", direct)], latest)).toEqual([]);
  });
});

describe("finding ids that stay put", () => {
  const keys = (obs: MachineObservation) =>
    diagnose([ok("a", obs)], latest)
      .filter((f) => f.area === "t3")
      .map((f) => f.key);

  it("names each T3 problem by its kind, not its place in the list", () => {
    const notRunning = { kind: "not-running", title: "T3 server (pid 9) is not running" };
    const noEnv = {
      kind: "env-unreadable",
      title: "could not read the T3 server's environment; providers checked with the login PATH",
    };
    expect(keys(machine({}, { problems: [noEnv] }))).toEqual(["t3-env-unreadable"]);
    expect(keys(machine({}, { problems: [notRunning, noEnv] }))).toEqual([
      "t3-not-running",
      "t3-env-unreadable",
    ]);
  });

  it("reads the kind from the text an older probe sent", () => {
    expect(
      keys(
        machine(
          {},
          {
            problems: [
              "T3 server (pid 9) is not running",
              "server at http://x did not answer /.well-known/t3/environment",
            ],
          },
        ),
      ),
    ).toEqual(["t3-not-running", "t3-no-descriptor"]);
  });

  it("names a plugin that failed by its path", () => {
    const failed = machine({
      areas: {
        _plugins: {
          problems: [
            { plugin: "plugins/brew.mjs", title: "plugin plugins/brew.mjs cannot load: x" },
          ],
        },
      },
    });
    expect(
      diagnose([ok("a", failed)], latest)
        .filter((f) => f.area === "plugins")
        .map((f) => f.key),
    ).toEqual(["plugin-failed-plugins/brew.mjs"]);
  });
});

describe("sync-stale", () => {
  const node = (interval?: number) => ({
    name: "a",
    ssh: "a",
    roles: ["member" as const],
    profiles: [],
    tailnet: null,
    settings: {
      table: interval === undefined ? {} : { engine: { interval } },
      provenance: new Map(),
    },
  });
  const ageMinutes = (minutes: number) =>
    machine({
      lastSync: { when: 1_791_000_000 - minutes * 60, result: "ok", message: "", streak: 0 },
    });
  const stale = (minutes: number, interval?: number) =>
    diagnose([ok("a", ageMinutes(minutes))], latest, {}, [node(interval)]).some(
      (f) => f.key === "sync-stale",
    );

  it("waits four runs of the node's own interval", () => {
    expect(stale(50)).toBe(false);
    expect(stale(70)).toBe(true);
    expect(stale(25, 300)).toBe(true);
    expect(stale(70, 3600)).toBe(false);
    expect(stale(250, 3600)).toBe(true);
  });
});

describe("t3-access", () => {
  const now = 1_791_000_000_000;
  const access = (
    state: "expiring" | "rejected" | "none",
    expiresAt: number | null,
    detail = "",
    lastAttempt?: number,
  ) =>
    diagnose(
      [
        ok(
          "a",
          machine(
            {},
            {
              access: {
                state,
                expiresAt,
                detail,
                cli: true,
                ...(lastAttempt === undefined ? {} : { lastAttempt }),
              },
            },
          ),
        ),
      ],
      latest,
    ).find((f) => f.key === "t3-access");

  it("lets sync renew a token that is running out or has run out", () => {
    expect(access("expiring", now + 86_400_000)?.fix).toEqual({
      command: "t3-fleet t3 connect",
      safe: true,
    });
    expect(access("rejected", now - 1000, "T3 Fleet's T3 token has expired")?.fix?.safe).toBe(true);
  });

  it("leaves a first connection, or a token T3 refused before it ran out, to a person", () => {
    expect(access("none", null)?.fix?.safe).toBe(false);
    expect(
      access("rejected", now + 20 * 86_400_000, "T3 refused T3 Fleet's token")?.fix?.safe,
    ).toBe(false);
    // Revoked in its last three days: still a person's call.
    expect(access("rejected", now + 86_400_000, "T3 refused T3 Fleet's token")?.fix?.safe).toBe(
      false,
    );
  });

  it("tries at most once a day", () => {
    const tried = access("expiring", now + 86_400_000, "", now - 2 * 3_600_000);
    expect(tried?.fix?.safe).toBe(false);
    expect(tried?.detail).toContain("tried to renew it 2 hours ago");
    expect(access("expiring", now + 86_400_000, "", now - 25 * 3_600_000)?.fix?.safe).toBe(true);
  });
});

describe("status table", () => {
  it("shows the version of an agent Nix installed, not missing", () => {
    const nix = machine({
      agents: [
        {
          name: "claude",
          managedPath: "/home/u/.local/bin/claude",
          managedVersion: null,
          onPath: ["/home/u/.nix-profile/bin/claude"],
          nix: { path: "/home/u/.nix-profile/bin/claude", version: "2.1.288" },
        },
        machine().agents[1]!,
      ],
    });
    const table = renderStatus([ok("nixos", nix)], [], latest, { verbose: false, elapsedMs: 1 });
    expect(table).toContain("2.1.288");
    expect(table).not.toContain("missing");
  });
});
