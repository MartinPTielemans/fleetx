import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { runningBuild } from "../Build.ts";
import { exec, type ExecInput, type ExecResult } from "../Exec.ts";
import { probeHub, bringUpHub, hubPlanSteps } from "./Remote.ts";

vi.mock("../Exec.ts", async (original) => ({
  ...(await original<typeof import("../Exec.ts")>()),
  exec: vi.fn(),
}));

vi.mock("../Build.ts", async (original) => ({
  ...(await original<typeof import("../Build.ts")>()),
  runningBuild: vi.fn(() => null),
}));
const bundle = "#!/usr/bin/env node\nconsole.log('same build');\n";
const readBundle = vi.fn<FileSystem.FileSystem["readFileString"]>(() => Effect.succeed(bundle));
const fs = FileSystem.makeNoop({ readFileString: readBundle });

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, timedOut: false });
const failed = (code = 1, stderr = ""): ExecResult => ({ ...ok(), code, stderr });
const timedOut: ExecResult = { ...ok(), code: null, timedOut: true };
const spawnError: ExecResult = { ...ok(), code: null, spawnError: "not found" };
const fake = vi.mocked(exec);
const scriptOf = (input: ExecInput) => input.stdin ?? input.args?.at(-1) ?? "";
const scripts = () => fake.mock.calls.map(([input]) => scriptOf(input));
const overrides = new Map<string, ExecResult>();
let progress: unknown = null;
const defaults = (script: string): ExecResult => {
  if (script.includes("hostname && uname")) return ok("hub\nLinux\n");
  if (script.includes("node --version")) return ok("v24.13.1\n");
  if (script.includes("git --version")) return ok("git version 2.47.0\n");
  if (script.includes("t3 --version")) return ok("t3 0.1.0\n");
  if (script.includes("t3 service status"))
    return ok("T3 Code service\n  Status: installed · t3@0.1.0\n");
  if (script.includes("/.well-known/t3/environment"))
    return ok('{"running":true,"version":"0.1.1"}\n');
  if (script.includes('"$ts" status --json'))
    return ok(
      JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "hub.tailnet.ts.net." },
        Peer: { somebody: { DNSName: "wrong.tailnet.ts.net." } },
      }),
    );
  if (script.includes("docker version")) return ok("29.0.0\n");
  if (script.includes("systemctl") && script.includes("show-environment"))
    return ok("systemd-user\n");
  if (script.includes("launchctl print")) return ok("launchd\n");
  if (script.includes("setup.json")) return ok(JSON.stringify(progress));
  if (script.includes(" secrets init")) return ok("existing key; public: age1testrecipient\n");
  return ok();
};
// The mocked exec still has its real spawner requirement. Keep real platform services on the runtime.
const probe = () => Effect.runPromise(probeHub("hub").pipe(Effect.provide(NodeServices.layer)));
const steps: Array<string> = [];
const input = {
  ssh: "hub",
  node: "server",
  repoUrl: "https://example.test/fleet.git",
  relayUrl: "https://hub.tailnet.ts.net:8399",
  onStep: (step: string) =>
    Effect.sync(() => {
      steps.push(step);
    }),
};
const bringUp = (over: Partial<typeof input> = {}) =>
  Effect.runPromise(
    bringUpHub({ ...input, ...over }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.result,
      Effect.provide(NodeServices.layer),
    ),
  );
const saved = (over: Record<string, unknown> = {}) => ({
  startedAt: 1,
  mode: "join",
  node: "server",
  checkout: "/scratch/fleet",
  url: input.repoUrl,
  input: {},
  done: ["snapshot", "clone"],
  failed: { step: "content", why: "interrupted" },
  finishedAt: null,
  ...over,
});

beforeEach(() => {
  readBundle.mockReset().mockReturnValue(Effect.succeed(bundle));
  vi.mocked(runningBuild).mockReset().mockReturnValue(null);
  overrides.clear();
  progress = null;
  steps.length = 0;
  fake.mockReset();
  fake.mockImplementation((input) => {
    const script = scriptOf(input);
    const entry = [...overrides].find(([fragment]) => script.includes(fragment));
    return Effect.succeed(entry?.[1] ?? defaults(script));
  });
});

describe("probeHub", () => {
  it("checks the login user, T3's live descriptor, and this host's MagicDNS name", async () => {
    const p = await probe();
    expect(p).toMatchObject({
      reachable: true,
      error: null,
      hostname: "hub",
      os: "Linux",
      ready: true,
      relayUrl: input.relayUrl,
    });
    for (const key of ["node", "git", "t3", "tailscale", "docker", "service"] as const)
      expect(p[key]).toMatchObject({ state: "ok", remedy: null });
    expect(p.t3.label).toContain("0.1.1 is running");
    expect(scripts()).toContainEqual(expect.stringContaining("systemctl --user"));
    for (const [call] of fake.mock.calls) {
      expect(call.command).toBe("ssh");
      expect(call.args).toEqual(
        expect.arrayContaining([
          "BatchMode=yes",
          "ConnectTimeout=10",
          "StrictHostKeyChecking=yes",
          "UpdateHostKeys=no",
          "--",
          "hub",
        ]),
      );
      expect(Duration.toMillis(call.timeout!)).toBeLessThanOrEqual(15_000);
    }
    expect(scripts().join("\n")).not.toMatch(
      /mkdir|enable-linger|service install|setup --yes|sudo/,
    );
  });

  it.each([
    ["Permission denied (publickey).", "SSH key"],
    ["Host key verification failed.", "host key"],
    ["REMOTE HOST IDENTIFICATION HAS CHANGED!", "host key"],
    ["Could not resolve hostname hub", "cannot find"],
    ["Connection timed out", "in time"],
    ["Connection refused", "SSH service"],
  ])("explains unreachable SSH: %s", async (error, words) => {
    overrides.set("hostname && uname", failed(255, error));
    const p = await probe();
    expect(p).toMatchObject({ reachable: false, ready: false });
    expect(p.error).toContain(words);
    expect(fake).toHaveBeenCalledTimes(1);
    for (const key of ["node", "git", "t3", "tailscale", "docker", "service"] as const)
      expect(p[key]).toMatchObject({ state: "unknown", remedy: expect.stringContaining("SSH") });
  });

  it.each([
    [timedOut, "in time"],
    [spawnError, "OpenSSH"],
  ])("explains timeout/spawn failure", async (result, words) => {
    overrides.set("hostname && uname", result);
    expect((await probe()).error).toContain(words);
  });

  it.each(["", "-oProxyCommand=oops", "hub\nwhoami", "user@hub extra"])(
    "rejects an SSH destination before executing: %s",
    async (ssh) => {
      const p = await Effect.runPromise(probeHub(ssh).pipe(Effect.provide(NodeServices.layer)));
      expect(p).toMatchObject({ reachable: false, ready: false });
      expect(fake).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["node --version", failed(127), "node", "missing", "Install Node"],
    ["node --version", ok("v22.0.0"), "node", "warn", "Upgrade"],
    ["node --version", ok("not a version"), "node", "unknown", "Install Node"],
    ["node --version", timedOut, "node", "unknown", "node --version"],
    ["git --version", failed(127), "git", "missing", "apt-get install git"],
    ["git --version", failed(), "git", "warn", "Install git"],
    ["git --version", spawnError, "git", "unknown", "git --version"],
    ["show-environment", failed(127), "service", "missing", "systemd"],
    ["show-environment", failed(), "service", "warn", "show-environment"],
    ["show-environment", failed(2), "service", "warn", "enable-linger"],
    ["show-environment", failed(3), "service", "unknown", "show-user"],
    ["show-environment", timedOut, "service", "unknown", "show-environment"],
  ] as const)(
    "required outcome and remedy: %s / %s",
    async (fragment, result, key, state, remedy) => {
      overrides.set(fragment, result);
      const p = await probe();
      expect(p[key]).toMatchObject({ state, remedy: expect.stringContaining(remedy) });
      expect(p.ready).toBe(false);
      if (key === "node")
        expect(scripts().some((s) => s.includes("/.well-known/t3/environment"))).toBe(false);
    },
  );

  it.each([
    ['"$ts" status --json', failed(127), "tailscale", "missing", "install Tailscale"],
    ['"$ts" status --json', failed(), "tailscale", "warn", "tailscale up"],
    [
      '"$ts" status --json',
      ok('{"BackendState":"Stopped","Self":{"DNSName":"hub.tailnet.ts.net"}}'),
      "tailscale",
      "warn",
      "tailscale up",
    ],
    [
      '"$ts" status --json',
      ok('{"BackendState":"Running","Peer":{"a":{"DNSName":"wrong.tailnet.ts.net"}}}'),
      "tailscale",
      "warn",
      "MagicDNS",
    ],
    [
      '"$ts" status --json',
      ok('{"BackendState":"Running","Self":{"DNSName":"bad/name"}}'),
      "tailscale",
      "warn",
      "MagicDNS",
    ],
    ['"$ts" status --json', ok("garbage"), "tailscale", "unknown", "status --json"],
    ['"$ts" status --json', timedOut, "tailscale", "unknown", "status --json"],
    ["docker version", failed(127), "docker", "missing", "install Docker"],
    ["docker version", failed(1, "permission denied"), "docker", "warn", "SSH user access"],
    ["docker version", ok(""), "docker", "warn", "Start Docker"],
    ["docker version", timedOut, "docker", "unknown", "docker version"],
  ] as const)(
    "recommended outcome and remedy: %s / %s",
    async (fragment, result, key, state, remedy) => {
      overrides.set(fragment, result);
      const p = await probe();
      expect(p[key]).toMatchObject({ state, remedy: expect.stringContaining(remedy) });
      expect(p.ready).toBe(true);
      if (key === "tailscale") expect(p.relayUrl).toBeNull();
    },
  );

  it("missing T3 remains optional and has an install remedy", async () => {
    overrides.set("t3 --version", failed(127));
    overrides.set("t3 service status", failed(127));
    overrides.set("/.well-known/t3/environment", ok('{"running":false,"version":null}'));
    expect(await probe()).toMatchObject({
      ready: true,
      t3: { state: "missing", remedy: expect.stringContaining("install T3 Code") },
    });
  });
  it.each([
    ["Status: installed", "restart"],
    ["Status: not installed", "install"],
  ])("a service status alone never proves T3 running: %s", async (status, remedy) => {
    overrides.set("t3 service status", ok(status));
    overrides.set("/.well-known/t3/environment", ok('{"running":false,"version":null}'));
    expect((await probe()).t3).toMatchObject({
      state: "warn",
      label: "T3 0.1.0 is installed but not running",
      remedy: expect.stringContaining(`t3 service ${remedy}`),
    });
  });
  it.each([timedOut, ok("garbage"), failed()])(
    "failed or malformed T3 descriptor is unknown",
    async (result) => {
      overrides.set("/.well-known/t3/environment", result);
      expect((await probe()).t3).toMatchObject({
        state: "unknown",
        remedy: expect.stringContaining("HTTP descriptor"),
      });
    },
  );
  it("detects a running desktop T3 even without a t3 CLI", async () => {
    overrides.set("t3 --version", failed(127));
    overrides.set("t3 service status", failed(127));
    expect((await probe()).t3.state).toBe("ok");
  });
  it("supports root's systemd manager without user linger", async () => {
    overrides.set("show-environment", ok("systemd-root"));
    expect((await probe()).service).toMatchObject({
      state: "ok",
      label: expect.stringContaining("root"),
    });
  });
  it.each([
    [ok("launchd"), "ok", null],
    [failed(), "warn", "macOS desktop"],
    [failed(127), "missing", "macOS desktop"],
  ] as const)("probes launchd's actual user session", async (result, state, remedy) => {
    overrides.set("hostname && uname", ok("mini\nDarwin\n"));
    overrides.set("launchctl print", result);
    const p = await probe();
    expect(p.service.state).toBe(state);
    expect(p.service.remedy).toEqual(remedy === null ? null : expect.stringContaining(remedy));
    expect(p.ready).toBe(state === "ok");
    expect(scripts().join("\n")).not.toContain("systemctl");
  });
  it("gives a macOS git remedy and rejects unsupported service managers", async () => {
    overrides.set("hostname && uname", ok("mini\nDarwin\n"));
    overrides.set("git --version", failed(127));
    expect((await probe()).git.remedy).toContain("brew install git");
    overrides.set("hostname && uname", ok("hub\nFreeBSD\n"));
    overrides.set("exit 127", failed(127));
    expect((await probe()).service.state).toBe("missing");
  });
  it("plans the exact build, resumable join and public key handoff without executing", async () => {
    const p = await probe();
    fake.mockClear();
    const plan = hubPlanSteps(p);
    expect(plan).toHaveLength(3);
    expect(plan[0]).toContain("unfinished");
    expect(plan[1]).toContain("build on hub");
    expect(plan[1]).toContain("restarting any existing");
    expect(plan[2]).toContain("member and relay");
    expect(hubPlanSteps({ ...p, hostname: null })[1]).toContain(p.ssh);
    expect(fake).not.toHaveBeenCalled();
  });
});

describe("bringUpHub", () => {
  it("installs the authority build and joins non-interactively, returning void", async () => {
    const result = await bringUp();
    expect(result).toMatchObject({ _tag: "Success", success: undefined });
    expect(steps).toEqual([
      "Checking for an unfinished setup on hub",
      "Installing T3 Fleet on hub",
      "Joining the fleet",
    ]);
    expect(scripts()).toHaveLength(4);
    expect(scripts()[2]).toContain(Buffer.from(bundle).toString("base64").slice(0, 50));
    expect(scripts()[3]).toContain(
      "setup https://example.test/fleet.git server --relay --yes --no-notify",
    );
    expect(scripts()[3]).not.toContain("--resume");
    expect(scripts().join("\n")).not.toContain("secrets init");
    expect(readBundle.mock.calls[0]?.[0]).toMatch(/apps\/cli\/dist\/bin\.mjs$/);
  });
  it("resumes a matching unfinished setup and never starts a fresh plan", async () => {
    progress = saved();
    expect((await bringUp())._tag).toBe("Success");
    expect(steps[2]).toBe("Resuming the hub's unfinished setup");
    expect(scripts()[3]).toContain("--yes --no-notify --resume");
  });
  it("skips completed join while its proposal awaits approval", async () => {
    progress = saved({ finishedAt: 2 });
    expect((await bringUp())._tag).toBe("Success");
    expect(scripts().some((s) => s.includes(" --relay --yes"))).toBe(false);
    expect(steps[2]).toBe("The hub has already joined the fleet");
    expect((await bringUp())._tag).toBe("Success");
  });
  it.each([{ node: "someone-else" }, { url: "https://example.test/other.git" }, { mode: "first" }])(
    "refuses unrelated or authority setup before installing",
    async (over) => {
      progress = saved(over);
      expect(await bringUp()).toMatchObject({
        _tag: "Failure",
        failure: expect.stringContaining("another node or repository"),
      });
      expect(fake).toHaveBeenCalledTimes(1);
      expect(steps).toHaveLength(1);
    },
  );
  it.each([
    ['node = "other"\nrepo = "~/fleet"\n', null, "another node"],
    ['node = "server"\nrepo = "~/fleet"\n', "https://example.test/other.git", "another repository"],
    ["not = valid = toml", null, "unreadable"],
  ])(
    "refuses mismatched or broken local membership before installation",
    async (config, origin, words) => {
      overrides.set("config.toml", ok(config));
      if (origin !== null) overrides.set("remote get-url", ok(origin));
      expect(await bringUp()).toMatchObject({
        _tag: "Failure",
        failure: expect.stringContaining(words),
      });
      expect(scripts().some((s) => s.includes("base64 -d"))).toBe(false);
    },
  );
  it("announces a step before its remote writes", async () => {
    const seen: Array<string | undefined> = [];
    fake.mockImplementation((i) => {
      seen.push(steps.at(-1));
      return Effect.succeed(defaults(scriptOf(i)));
    });
    expect((await bringUp())._tag).toBe("Success");
    expect(seen).toEqual([
      "Checking for an unfinished setup on hub",
      "Checking for an unfinished setup on hub",
      "Installing T3 Fleet on hub",
      "Joining the fleet",
    ]);
  });
  it("scrubs embedded repository credentials and private keys from failures", async () => {
    overrides.set(
      " --relay --yes",
      failed(1, "cannot clone https://user:SEKRIT@example.test/fleet.git AGE-SECRET-KEY-PRIVATE"),
    );
    const result = await bringUp();
    expect(JSON.stringify(result)).not.toContain("SEKRIT");
    expect(JSON.stringify(result)).not.toContain("AGE-SECRET-KEY-PRIVATE");
  });
  it("refuses unreadable saved setup", async () => {
    overrides.set("setup.json", ok("not JSON"));
    expect(await bringUp()).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("unreadable"),
    });
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ssh: "-oops" },
    { node: "../server" },
    { node: "Uppercase" },
    { repoUrl: "--help" },
    { relayUrl: "bad" },
  ])("rejects bad inputs before any machine changes", async (over) => {
    expect((await bringUp(over))._tag).toBe("Failure");
    expect(fake).not.toHaveBeenCalled();
    expect(steps).toHaveLength(0);
  });
  it("rejects an empty or missing authority build before SSH", async () => {
    readBundle.mockReturnValueOnce(Effect.succeed(""));
    expect(await bringUp()).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("empty"),
    });
    expect(fake).not.toHaveBeenCalled();
  });
  it("refuses a build replaced since the running wizard started", async () => {
    vi.mocked(runningBuild).mockReturnValue({ version: "0.6.0", builtAt: 1, commit: "abc1234" });
    readBundle.mockReturnValue(Effect.succeed("t3-fleet-build:0.6.0:2:abc1234"));
    expect(await bringUp()).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("Restart the wizard"),
    });
    expect(fake).not.toHaveBeenCalled();
  });
  it("allows the running build when its on-disk marker still matches", async () => {
    vi.mocked(runningBuild).mockReturnValue({ version: "0.6.0", builtAt: 1, commit: "abc1234" });
    readBundle.mockReturnValue(Effect.succeed("t3-fleet-build:0.6.0:1:abc1234"));
    expect((await bringUp())._tag).toBe("Success");
  });
  it("stops after a failed install, leaving join untouched", async () => {
    overrides.set("base64 -d", failed(1, "Permission denied"));
    expect(await bringUp()).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("Installing T3 Fleet failed"),
    });
    expect(steps).toHaveLength(2);
    expect(fake).toHaveBeenCalledTimes(3);
  });
  it("resumes after a partial join failure", async () => {
    overrides.set(
      " --relay --yes",
      failed(1, 'setup stopped at "content"; fix that, then t3-fleet setup --resume'),
    );
    expect(await bringUp()).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("unfinished setup will resume"),
    });
    expect(steps).toHaveLength(3);
    progress = saved();
    overrides.clear();
    fake.mockClear();
    steps.length = 0;
    expect((await bringUp())._tag).toBe("Success");
    expect(scripts()[3]).toContain("--resume");
  });
  it("reports a timeout as a recoverable SSH error", async () => {
    overrides.set(" --relay --yes", timedOut);
    expect(await bringUp()).toMatchObject({
      _tag: "Failure",
      failure: expect.stringContaining("in time"),
    });
  });
  it("quotes repository shell characters instead of executing them", async () => {
    await bringUp({ repoUrl: "https://example.test/fleet's$(touch BAD).git" });
    expect(scripts()[3]).toContain("'https://example.test/fleet'\\''s$(touch BAD).git'");
  });
});
