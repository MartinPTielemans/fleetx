// The launcher test runs the real shell script against a fake CLI in a scratch HOME.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { ModelProxyStats } from "../Api.ts";
import { ModelsArea } from "../areas/Models.ts";
import { diagnose } from "../Diagnose.ts";
import type { MachineObservation } from "../Observation.ts";
import type { NodeResult } from "../Remote.ts";
import { parseClaudeAuth } from "./ClaudeAuth.ts";
import { endsAtEventBoundary, openaiBase, requestHeaders, retryAfterMs, retryDelay, splitPath, UPSTREAMS } from "./Forward.ts";
import { claudeLauncher, codexLauncher, serviceUnitText } from "./Launchers.ts";
import { withBinaryPath } from "./Route.ts";
import { parseFallbacks, percentile, proxyStats, type RequestRecord } from "./Stats.ts";

describe("retries", () => {
  const base = { attempt: 0, status: null, retryAfter: null, random: 0.5 };
  it("retries connection errors and the transient statuses, three times", () => {
    expect(retryDelay(base)).toBe(500);
    for (const status of [408, 429, 500, 502, 503, 504, 529]) expect(retryDelay({ ...base, status })).not.toBeNull();
    expect(retryDelay({ ...base, attempt: 2 })).toBe(2000);
    expect(retryDelay({ ...base, attempt: 3 })).toBeNull();
  });
  it("passes other statuses on", () => {
    for (const status of [200, 400, 401, 403, 404, 413, 501]) expect(retryDelay({ ...base, status })).toBeNull();
  });
  it("honours retry-after up to 30s, and gives up beyond it", () => {
    expect(retryDelay({ ...base, status: 429, retryAfter: 7000 })).toBe(7000);
    expect(retryDelay({ ...base, status: 429, retryAfter: 30_000 })).toBe(30_000);
    expect(retryDelay({ ...base, status: 429, retryAfter: 31_000 })).toBeNull();
  });
  it("jitters the backoff", () => {
    expect(retryDelay({ ...base, random: 0 })).toBe(250);
    expect(retryDelay({ ...base, random: 0.999 })).toBe(750);
  });
  it("reads retry-after as seconds or a date", () => {
    expect(retryAfterMs("3", 0)).toBe(3000);
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:10 GMT", 4000)).toBe(6000);
    expect(retryAfterMs(undefined, 0)).toBeNull();
    expect(retryAfterMs("soon", 0)).toBeNull();
  });
});

describe("forwarding", () => {
  it("splits the route from the upstream path, keeping the query", () => {
    expect(splitPath("/anthropic/v1/messages?beta=true")).toEqual({ upstream: "anthropic", rest: "/v1/messages?beta=true" });
    expect(splitPath("/egress/openai/responses", "/egress")).toEqual({ upstream: "openai", rest: "/responses" });
    expect(splitPath("/other/v1")).toBeNull();
  });
  it("tells a ChatGPT login from an API key", () => {
    expect(openaiBase({ "chatgpt-account-id": "a" })).toBe(UPSTREAMS.openaiChatgpt);
    expect(openaiBase({ authorization: "Bearer eyJhbGciOi.eyJzdWIi.sig" })).toBe(UPSTREAMS.openaiChatgpt);
    expect(openaiBase({ authorization: "Bearer sk-proj-abc" })).toBe(UPSTREAMS.openaiApi);
  });
  it("drops hop-by-hop headers only", () => {
    expect(requestHeaders({ authorization: "a", "user-agent": "u", host: "h", connection: "keep-alive", "content-length": "3", "x-fleetx-relay-token": "t", version: "1" })).toEqual({
      authorization: "a",
      "user-agent": "u",
      version: "1",
    });
  });
  it("knows where an event ends", () => {
    expect(endsAtEventBoundary("")).toBe(true);
    expect(endsAtEventBoundary("a\n\n")).toBe(true);
    expect(endsAtEventBoundary("data: x\n")).toBe(false);
  });
});

describe("stats windows", () => {
  const now = 100 * 60 * 60_000;
  const record = (minutesAgo: number, over: Partial<RequestRecord> = {}): RequestRecord => ({
    at: now - minutesAgo * 60_000,
    upstream: "anthropic",
    method: "POST",
    path: "/v1/messages",
    status: 200,
    attempts: 1,
    ttfbMs: 100,
    durationMs: 1000,
    failure: null,
    error: null,
    ...over,
  });
  const records = [
    record(2, { ttfbMs: 300 }),
    record(3, { attempts: 2 }),
    record(30, { status: 529, failure: "529", error: "HTTP 529", ttfbMs: 50 }),
    record(600, { status: null, failure: "connect", error: "ECONNREFUSED", ttfbMs: null }),
    record(25 * 60),
    record(1, { upstream: "openai" }),
  ];
  const stats = proxyStats({ now, startedAt: 0, version: "v", egress: "direct", records, fallbacks: [{ at: now - 10 * 60_000, upstream: "openai" }] });
  const anthropic = stats.upstreams.find((u) => u.upstream === "anthropic");
  const openai = stats.upstreams.find((u) => u.upstream === "openai");

  it("counts each window from its own start", () => {
    expect(anthropic?.m5).toMatchObject({ requests: 2, retried: 1, failed: 0, ttfbP50Ms: 100, ttfbP95Ms: 300 });
    expect(anthropic?.h1).toMatchObject({ requests: 3, failed: 1, failures: { "529": 1 } });
    expect(anthropic?.h24).toMatchObject({ requests: 4, failed: 2, failures: { "529": 1, connect: 1 } });
  });
  it("keeps upstreams apart and counts fallbacks", () => {
    expect(openai?.m5.requests).toBe(1);
    expect(openai?.m5.fallbacks).toBe(0);
    expect(openai?.h1.fallbacks).toBe(1);
    expect(anthropic?.h1.fallbacks).toBe(0);
  });
  it("remembers the last error", () => {
    expect(anthropic?.lastError).toEqual({ at: now - 30 * 60_000, class: "529", message: "HTTP 529" });
    expect(openai?.lastError).toBeNull();
  });
  it("takes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95)).toBe(19);
  });
  it("reads the launchers' fallback log", () => {
    expect(parseFallbacks("1700000000\tanthropic\tproxy not listening\ngarbage\n1700000060\topenai\tx\n")).toEqual([
      { at: 1_700_000_000_000, upstream: "anthropic" },
      { at: 1_700_000_060_000, upstream: "openai" },
    ]);
  });
});

describe("launchers", () => {
  it("point the CLIs at the proxy, never rewriting who they are", () => {
    const claude = claudeLauncher("CLAUDE_CODE_OAUTH_TOKEN");
    expect(claude).toContain('export ANTHROPIC_BASE_URL="$proxy/anthropic"');
    expect(claude).toContain('proxy="http://127.0.0.1:8398"');
    expect(claude).not.toMatch(/user-agent|ANTHROPIC_CUSTOM_HEADERS/i);
    expect(codexLauncher()).toContain('exec "$cli" -c "openai_base_url=\\"$proxy/openai\\"" "$@"');
  });

  const scratch = () => {
    const home = mkdtempSync(`${tmpdir()}/fleetx-launcher-`);
    mkdirSync(`${home}/.local/bin`, { recursive: true });
    mkdirSync(`${home}/.config/fleetx`, { recursive: true });
    // A fake CLI that prints what it was given.
    for (const name of ["claude", "codex"]) {
      writeFileSync(`${home}/.local/bin/${name}`, '#!/bin/sh\necho "args=$*"\necho "base=${ANTHROPIC_BASE_URL:-}"\necho "token=${CLAUDE_CODE_OAUTH_TOKEN:-}"\n');
      chmodSync(`${home}/.local/bin/${name}`, 0o755);
    }
    writeFileSync(`${home}/.local/bin/fleetx-claude`, claudeLauncher("MY_TOKEN"));
    writeFileSync(`${home}/.local/bin/fleetx-codex`, codexLauncher());
    writeFileSync(`${home}/.config/fleetx/secrets.env`, 'OTHER=1\nMY_TOKEN="sk-ant-oat01-abc"\n');
    return home;
  };
  // Nothing listens on 8398 in CI; the launcher must fall back and say so.
  const run = (home: string, name: string, args: ReadonlyArray<string>) =>
    execFileSync("/bin/sh", [`${home}/.local/bin/fleetx-${name}`, ...args], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });

  it("load the setup-token, and fall back to the CLI when the proxy is not listening", () => {
    const home = scratch();
    const out = run(home, "claude", ["-p", "hi"]);
    const listening = out.includes("base=http://127.0.0.1:8398/anthropic");
    expect(out).toContain("args=-p hi");
    expect(out).toContain("token=sk-ant-oat01-abc");
    if (!listening) {
      expect(out).toContain("base=\n");
      expect(readFileSync(`${home}/.local/state/fleetx/models-fallback.log`, "utf8")).toMatch(/^\d+\tanthropic\tproxy not listening\n$/);
    }
  });

  it("run status and version commands directly, without counting a fallback", () => {
    const home = scratch();
    expect(run(home, "claude", ["auth", "status"])).toContain("token=sk-ant-oat01-abc");
    expect(run(home, "codex", ["--version"])).toContain("args=--version");
    expect(() => readFileSync(`${home}/.local/state/fleetx/models-fallback.log`, "utf8")).toThrow();
  });

  it("start the proxy with its egress", () => {
    expect(serviceUnitText("linux", false, "/h", "/usr/bin/node", "/b.mjs", "relay")).toContain("ExecStart=/usr/bin/node /b.mjs models serve --egress relay");
    expect(serviceUnitText("darwin", false, "/h", "/n", "/b.mjs")).toContain("<string>models</string><string>serve</string></array>");
  });
});

describe("routing T3's provider", () => {
  const edit = (text: string, id: string, path: string | null) => Effect.runSync(withBinaryPath(text, id, path));

  it("changes only the explicit instance's binaryPath", () => {
    const before = { theme: "dark", providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true, config: { binaryPath: "claude", homePath: "~/.c" } } } };
    const after = JSON.parse(edit(JSON.stringify(before), "claudeAgent", "/h/.local/bin/fleetx-claude").text);
    expect(after).toEqual({ ...before, providerInstances: { claudeAgent: { ...before.providerInstances.claudeAgent, config: { binaryPath: "/h/.local/bin/fleetx-claude", homePath: "~/.c" } } } });
  });
  it("uses the legacy block for a built-in instance T3 builds from it", () => {
    const after = edit('{"providers":{"codex":{"enabled":true}}}', "codex", "/h/.local/bin/fleetx-codex");
    expect(JSON.parse(after.text)).toEqual({ providers: { codex: { enabled: true, binaryPath: "/h/.local/bin/fleetx-codex" } } });
    expect(after.previous).toBeNull();
    expect(JSON.parse(edit("{}", "claudeAgent", "/x").text)).toEqual({ providers: { claudeAgent: { binaryPath: "/x" } } });
  });
  it("removes the field to restore T3's default, and refuses unknown instances", () => {
    expect(JSON.parse(edit('{"providers":{"codex":{"binaryPath":"/x"}}}', "codex", null).text)).toEqual({ providers: { codex: {} } });
    expect(Effect.runSync(Effect.flip(withBinaryPath("{}", "nope", "/x"))).message).toContain("no provider instance named nope");
  });
});

describe("claude auth status", () => {
  it("reads each login method", () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}', null)).toEqual({
      loggedIn: true,
      method: "oauth",
      detail: "max subscription login",
    });
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token"}', "Auth token: CLAUDE_CODE_OAUTH_TOKEN\n").method).toBe("setup-token");
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token"}', "Auth token: ANTHROPIC_AUTH_TOKEN\n").method).toBe("auth-token");
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}', null).method).toBe("api-key");
  });
  it("says logged out, or that it cannot tell", () => {
    expect(parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}', null)).toEqual({ loggedIn: false, method: null, detail: "not logged in" });
    expect(parseClaudeAuth("error: unknown command auth", null).loggedIn).toBeNull();
  });
});

// ---- diagnose ----------------------------------------------------------------

const LAUNCHER = { name: "claude" as const, path: "/h/.local/bin/fleetx-claude", installed: "x", want: "x" };
const observed = (over: Record<string, unknown> = {}) => ({
  on: true,
  platform: "linux",
  root: false,
  service: { installed: "unit", want: "unit", running: true },
  launchers: [LAUNCHER],
  providers: [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, binaryPath: "/h/.local/bin/fleetx-claude", launcher: LAUNCHER.path }],
  tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  tokenSet: true,
  fallbacksH1: 0,
  stats: null as ModelProxyStats | null,
  ...over,
});
const window = (requests: number, failed: number, failures: Record<string, number> = {}) => ({
  requests,
  retried: 0,
  failed,
  failures,
  fallbacks: 0,
  ttfbP50Ms: null,
  ttfbP95Ms: null,
});
const healthy: ModelProxyStats = {
  at: 1,
  startedAt: 0,
  version: "v",
  egress: "direct",
  upstreams: [{ upstream: "anthropic", m5: window(10, 0), h1: window(100, 0), h24: window(1000, 0), lastError: null }],
};
const keys = (o: ReturnType<typeof observed>) =>
  ModelsArea.diagnose({ node: "n", desired: {}, observed: o, fleet: [], authority: null }).map((f) => f.key);

describe("models area", () => {
  it("is quiet when everything is in place", () => {
    expect(keys(observed({ stats: healthy }))).toEqual([]);
  });
  it("says nothing when [models] is off", () => {
    expect(keys(observed({ on: false, service: { installed: null, want: null, running: false }, tokenSet: false }))).toEqual([]);
  });
  it("reports a missing, stale or silent service with a safe fix", () => {
    for (const service of [
      { installed: null, want: "unit", running: false },
      { installed: "old", want: "unit", running: true },
      { installed: "unit", want: "unit", running: false },
    ]) {
      const [finding] = ModelsArea.diagnose({ node: "n", desired: {}, observed: observed({ service, stats: healthy }), fleet: [], authority: null });
      expect(finding?.key).toBe("models-service");
      expect(finding?.fix?.safe).toBe(true);
    }
    expect(keys(observed({ stats: null }))).toEqual(["models-service"]);
  });
  it("reports a launcher that is missing or out of date", () => {
    expect(keys(observed({ stats: healthy, launchers: [{ ...LAUNCHER, installed: null }] }))).toContain("models-launcher");
  });
  it("routes a provider once its launcher is in place, never before", () => {
    const direct = [{ instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, binaryPath: "claude", launcher: LAUNCHER.path }];
    const ready = ModelsArea.diagnose({ node: "n", desired: {}, observed: observed({ stats: healthy, providers: direct }), fleet: [], authority: null });
    expect(ready.map((f) => f.key)).toEqual(["models-not-routed-claudeAgent"]);
    expect(ready[0]?.fix).toEqual({ command: "fleetx models route claudeAgent", safe: false });
    const missing = ModelsArea.diagnose({
      node: "n",
      desired: {},
      observed: observed({ stats: healthy, providers: direct, launchers: [{ ...LAUNCHER, installed: null }] }),
      fleet: [],
      authority: null,
    });
    expect(missing.find((f) => f.key === "models-not-routed-claudeAgent")?.fix).toBeUndefined();
  });
  it("asks for a setup-token where T3 runs Claude", () => {
    expect(keys(observed({ stats: healthy, tokenSet: false }))).toEqual(["claude-token-missing"]);
  });
  it("warns above 5% failures in the last hour, naming the class, or on fallbacks", () => {
    const bad: ModelProxyStats = { ...healthy, upstreams: [{ ...healthy.upstreams[0]!, h1: window(100, 6, { "529": 5, connect: 1 }) }] };
    const [failing] = ModelsArea.diagnose({ node: "n", desired: {}, observed: observed({ stats: bad }), fleet: [], authority: null });
    expect(failing?.key).toBe("models-failing");
    expect(failing?.detail).toContain("mostly 529");
    const edge: ModelProxyStats = { ...healthy, upstreams: [{ ...healthy.upstreams[0]!, h1: window(100, 5) }] };
    expect(keys(observed({ stats: edge }))).toEqual([]);
    expect(keys(observed({ stats: healthy, fallbacksH1: 2 }))).toEqual(["models-failing"]);
  });
});

describe("claude-logged-out", () => {
  const obs = (claude: MachineObservation["claude"]) =>
    ({
      protocol: 5,
      hostname: "h",
      platform: "linux",
      arch: "x64",
      user: "u",
      observedAt: 0,
      agents: [],
      t3: { runtime: null, descriptor: null, installedVersion: null, runtimeBinary: null, serverPath: null, providers: [], problems: ["x"] },
      claude,
      proxy: null,
      areas: {},
      legacySync: null,
    }) satisfies MachineObservation;
  const result = (observation: MachineObservation): NodeResult => ({
    node: { name: "n", ssh: null, roles: ["member"], profiles: [], tailnet: null, settings: { table: {}, provenance: new Map() } },
    ok: true,
    observation,
    ms: 1,
  });
  const found = (claude: MachineObservation["claude"]) =>
    diagnose([result(obs(claude))], { agents: { claude: null, codex: null }, t3: {} }, {}, [], []).filter((f) => f.key === "claude-logged-out");

  it("is an error when T3's Claude is logged out, with or without [models]", () => {
    const [f] = found({ loggedIn: false, method: null, detail: "not logged in" });
    expect(f?.severity).toBe("error");
    expect(f?.detail).toContain("claude setup-token");
  });
  it("is silent when logged in or unknown", () => {
    expect(found({ loggedIn: true, method: "oauth", detail: "" })).toEqual([]);
    expect(found({ loggedIn: null, method: null, detail: "timed out" })).toEqual([]);
    expect(found(null)).toEqual([]);
  });
});
