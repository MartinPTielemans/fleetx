// The launcher test runs the real shell script against a fake CLI in a scratch HOME.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { ModelProxyStats, ProviderAuth } from "../Api.ts";
import { ModelsArea } from "../areas/Models.ts";
import { diagnose } from "../Diagnose.ts";
import type { MachineObservation } from "../Observation.ts";
import type { NodeResult } from "../Remote.ts";
import { parseClaudeAuth, parseCodexLogin } from "../CliLogin.ts";
import { fromSnapshot, t3CliFromCommandLine } from "../T3Access.ts";
import { endsAtEventBoundary, requestHeaders, retryAfterMs, retryDelay, splitPath, targetUrl } from "./Forward.ts";
import { launcherText, serviceUnitText } from "./Launchers.ts";
import { BUILTIN_UPSTREAMS, resolveRecipe, upstreamsOf, type Recipe } from "./Recipes.ts";
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
  it("splits the upstream's name from the path, keeping the query", () => {
    expect(splitPath("/anthropic/v1/messages?beta=true")).toEqual({ upstream: "anthropic", rest: "/v1/messages?beta=true" });
    expect(splitPath("/egress/openai/responses", "/egress")).toEqual({ upstream: "openai", rest: "/responses" });
    expect(splitPath("/")).toBeNull();
  });
  it("sends a ChatGPT login to the ChatGPT backend and an API key to the API", () => {
    expect(targetUrl(BUILTIN_UPSTREAMS, "openai", "/responses", { "chatgpt-account-id": "a" })).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(targetUrl(BUILTIN_UPSTREAMS, "openai", "/responses", { authorization: "Bearer eyJhbGciOi.eyJzdWIi.sig" })).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(targetUrl(BUILTIN_UPSTREAMS, "openai", "/responses", { authorization: "Bearer sk-proj-abc" })).toBe("https://api.openai.com/v1/responses");
    expect(targetUrl(BUILTIN_UPSTREAMS, "anthropic", "/v1/messages", { "chatgpt-account-id": "a" })).toBe("https://api.anthropic.com/v1/messages");
    expect(targetUrl(BUILTIN_UPSTREAMS, "nowhere", "/x", {})).toBeNull();
  });
  it("drops hop-by-hop headers only", () => {
    expect(
      requestHeaders({ authorization: "a", "user-agent": "u", host: "h", connection: "keep-alive", "content-length": "3", "x-fleetx-relay-token": "t", "x-fleetx-egress-base": "b", version: "1" }),
    ).toEqual({ authorization: "a", "user-agent": "u", version: "1" });
  });
  it("knows where an event ends", () => {
    expect(endsAtEventBoundary("")).toBe(true);
    expect(endsAtEventBoundary("a\n\n")).toBe(true);
    expect(endsAtEventBoundary("data: x\n")).toBe(false);
  });
});

describe("upstreams and recipes", () => {
  it("overlays declared upstreams on the built-ins, refusing reserved or broken ones", () => {
    const upstreams = upstreamsOf({
      upstreams: { anthropic: { url: "https://gw.example/anthropic/" }, xai: { url: "https://api.x.ai/v1" }, stats: { url: "https://x" }, bad: { url: "ftp://x" } },
    });
    expect(upstreams["anthropic"]).toEqual({ url: "https://gw.example/anthropic" });
    expect(upstreams["openai"]?.chatgptUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(upstreams["xai"]).toEqual({ url: "https://api.x.ai/v1" });
    expect(Object.keys(upstreams)).not.toContain("stats");
    expect(Object.keys(upstreams)).not.toContain("bad");
  });
  it("routes Claude and Codex out of the box", () => {
    const claude = resolveRecipe("claudeAgent", "claudeAgent", {}, BUILTIN_UPSTREAMS);
    expect(claude._tag === "route" && claude.recipe).toMatchObject({ upstream: "anthropic", env: { ANTHROPIC_BASE_URL: "{proxy}" }, tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN" });
    const codex = resolveRecipe("codex", "codex", {}, BUILTIN_UPSTREAMS);
    expect(codex._tag === "route" && codex.recipe).toMatchObject({ upstream: "openai", args: ["-c", 'openai_base_url="{proxy}"'], tokenEnv: null });
  });
  it("routes another driver once its recipe is declared, and says why not otherwise", () => {
    const settings = { upstreams: { xai: { url: "https://api.x.ai/v1" } }, providers: { grok: { upstream: "xai", env: { XAI_BASE_URL: "{proxy}" }, token_env: "XAI_API_KEY" } } };
    const grok = resolveRecipe("grok", "grok", settings, upstreamsOf(settings));
    expect(grok._tag === "route" && grok.recipe).toMatchObject({ command: "grok", upstream: "xai", tokenEnv: "XAI_API_KEY" });
    const pi = resolveRecipe("pi", "pi", {}, BUILTIN_UPSTREAMS);
    expect(pi._tag === "unroutable" && pi.reason).toContain("declare [models.providers.pi]");
    const cursor = resolveRecipe("cursor", "cursor", {}, BUILTIN_UPSTREAMS);
    expect(cursor._tag === "unroutable" && cursor.reason).toContain("SDK provider");
    expect(resolveRecipe("codex", "codex", { providers: { codex: { route: false } } }, BUILTIN_UPSTREAMS)._tag).toBe("skip");
  });
  it("writes no launcher for a recipe with a newline or control character anywhere", () => {
    const ok = { upstream: "openai", env: { X_BASE_URL: "{proxy}" } };
    for (const providers of [
      { "co\ndex": ok },
      { codex: { ...ok, command: "codex\nFLEETX_LAUNCHER\nrm -rf ~" } },
      { codex: { ...ok, env: { X_BASE_URL: "{proxy}\nFLEETX_LAUNCHER" } } },
      { codex: { ...ok, args: ["-c", "a\rb"] } },
      { codex: { ...ok, token_env: "T\u0000" } },
    ]) {
      const [id] = Object.keys(providers);
      const r = resolveRecipe(id ?? "", "codex", { providers }, BUILTIN_UPSTREAMS);
      expect(r._tag).toBe("unroutable");
      expect(r._tag === "unroutable" && r.reason).toContain("newline or control character");
    }
    expect(resolveRecipe("codex", "codex", { providers: { codex: { upstream: "gone" } } }, BUILTIN_UPSTREAMS)._tag).toBe("unroutable");
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
  const stats = proxyStats({ names: ["anthropic", "openai"], now, startedAt: 0, version: "v", egress: "direct", records, fallbacks: [{ at: now - 10 * 60_000, upstream: "openai" }] });
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

const recipe = (instanceId: string, driver: string, settings = {}): Recipe => {
  const r = resolveRecipe(instanceId, driver, settings, upstreamsOf(settings));
  if (r._tag !== "route") throw new Error(`no recipe for ${instanceId}`);
  return r.recipe;
};

describe("launchers", () => {
  it("point the CLIs at the proxy, never rewriting who they are", () => {
    const claude = launcherText("claudeAgent", recipe("claudeAgent", "claudeAgent"));
    expect(claude).toContain('export ANTHROPIC_BASE_URL="$proxy"');
    expect(claude).toContain('proxy="http://127.0.0.1:8398/anthropic"');
    expect(claude).not.toMatch(/user-agent|ANTHROPIC_CUSTOM_HEADERS/i);
    expect(launcherText("codex", recipe("codex", "codex"))).toContain('exec "$cli" "-c" "openai_base_url=\\"$proxy\\"" "$@"');
  });

  const scratch = () => {
    const home = mkdtempSync(`${tmpdir()}/fleetx-launcher-`);
    mkdirSync(`${home}/.local/bin`, { recursive: true });
    mkdirSync(`${home}/.config/fleetx`, { recursive: true });
    // A fake CLI that prints what it was given.
    const fake = '#!/bin/sh\necho "args=$*"\necho "base=${ANTHROPIC_BASE_URL:-}${XAI_BASE_URL:-}"\necho "token=${CLAUDE_CODE_OAUTH_TOKEN:-}${XAI_API_KEY:-}"\n';
    for (const name of ["claude", "codex", "grok"]) {
      writeFileSync(`${home}/.local/bin/${name}`, fake);
      chmodSync(`${home}/.local/bin/${name}`, 0o755);
    }
    const grokSettings = { upstreams: { xai: { url: "https://api.x.ai/v1" } }, providers: { grok: { upstream: "xai", command: "~/.local/bin/grok", env: { XAI_BASE_URL: "{proxy}/v1" }, token_env: "XAI_API_KEY" } } };
    writeFileSync(`${home}/.local/bin/fleetx-claude`, launcherText("claudeAgent", recipe("claudeAgent", "claudeAgent")));
    writeFileSync(`${home}/.local/bin/fleetx-codex`, launcherText("codex", recipe("codex", "codex")));
    writeFileSync(`${home}/.local/bin/fleetx-grok`, launcherText("grok", recipe("grok", "grok", grokSettings)));
    writeFileSync(`${home}/.config/fleetx/secrets.env`, 'OTHER=1\nCLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-abc"\nexport XAI_API_KEY=xai-1\n');
    return home;
  };
  // Nothing listens on 8398 in CI; the launcher must fall back and say so.
  const run = (home: string, name: string, args: ReadonlyArray<string>) =>
    execFileSync("/bin/sh", [`${home}/.local/bin/fleetx-${name}`, ...args], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });

  it("load the long-lived token, and fall back to the CLI when the proxy is not listening", () => {
    const home = scratch();
    const out = run(home, "claude", ["-p", "hi"]);
    expect(out).toContain("args=-p hi");
    expect(out).toContain("token=sk-ant-oat01-abc");
    if (!out.includes("base=http://127.0.0.1:8398/anthropic")) {
      expect(out).toContain("base=\n");
      expect(readFileSync(`${home}/.local/state/fleetx/models-fallback.log`, "utf8")).toMatch(/^\d+\tanthropic\tproxy not listening\n$/);
    }
    expect(run(home, "grok", ["chat"])).toContain("token=xai-1");
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

describe("CLI login fallbacks", () => {
  it("read each Claude login method", () => {
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}', null)).toEqual({
      auth: "authenticated",
      method: "claude.ai",
      detail: "max subscription login",
    });
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token"}', "Auth token: CLAUDE_CODE_OAUTH_TOKEN\n").method).toBe("setup-token");
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"oauth_token"}', "Auth token: ANTHROPIC_AUTH_TOKEN\n").method).toBe("auth-token");
    expect(parseClaudeAuth('{"loggedIn":true,"authMethod":"api_key","apiKeySource":"ANTHROPIC_API_KEY"}', null).method).toBe("api-key");
    expect(parseClaudeAuth('{"loggedIn":false,"authMethod":"none"}', null)).toEqual({ auth: "unauthenticated", method: null, detail: "not logged in" });
    expect(parseClaudeAuth("error: unknown command auth", null).auth).toBe("unknown");
  });
  it("read Codex's login status", () => {
    expect(parseCodexLogin("Logged in using ChatGPT\n")).toMatchObject({ auth: "authenticated", method: "chatgpt" });
    expect(parseCodexLogin("Logged in using an API key - sk-proj-***abc\n")).toMatchObject({ auth: "authenticated", method: "api-key" });
    expect(parseCodexLogin("Not logged in\n").auth).toBe("unauthenticated");
    expect(parseCodexLogin("").auth).toBe("unknown");
  });
});

describe("T3's provider snapshot", () => {
  it("keeps what fleetx reports, and never the email", () => {
    const auth = fromSnapshot({
      instanceId: "codex" as never,
      driver: "codex" as never,
      enabled: true,
      installed: true,
      version: "0.160.0",
      status: "ready",
      auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Pro", email: "someone@example.com" },
      checkedAt: "2026-10-03T22:14:22.425Z",
    });
    expect(auth).toEqual({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      auth: "authenticated",
      method: "chatgpt",
      label: "ChatGPT Pro",
      status: "ready",
      detail: "version 0.160.0",
      checkedAt: Date.parse("2026-10-03T22:14:22.425Z"),
      source: "t3",
    });
  });
  it("finds T3's CLI in a CLI install's and the desktop app's server command line", () => {
    expect(t3CliFromCommandLine("/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2632/t3 serve --port 3773")).toEqual({
      command: "/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2632/t3",
      args: [],
      env: {},
    });
    const app = "/Applications/T3 Code (Nightly).app/Contents";
    expect(t3CliFromCommandLine(`${app}/MacOS/T3 Code (Nightly) --require ${app}/Resources/app.asar/apps/desktop/dist-electron/compileCache.cjs ${app}/Resources/app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3`)).toEqual({
      command: `${app}/MacOS/T3 Code (Nightly)`,
      args: [`${app}/Resources/app.asar/apps/server/dist/bin.mjs`],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(t3CliFromCommandLine("node server.js")).toBeNull();
  });
});

// ---- diagnose ----------------------------------------------------------------

const LAUNCHER = { path: "/h/.local/bin/fleetx-claude", installed: "x", want: "x" };
type Observed = Parameters<typeof ModelsArea.diagnose>[0]["observed"];
const claudeProvider = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  binaryPath: "/h/.local/bin/fleetx-claude",
  upstream: "anthropic",
  launcher: LAUNCHER,
  unroutable: null,
  token: { env: "CLAUDE_CODE_OAUTH_TOKEN", set: true, help: "run `claude setup-token` once" },
};
const observed = (over: Record<string, unknown> = {}): Observed => ({
  on: true,
  platform: "linux",
  root: false,
  service: { installed: "unit", want: "unit", running: true },
  providers: [claudeProvider],
  fallbacksH1: 0,
  stats: null,
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
const findings = (o: Observed) => ModelsArea.diagnose({ node: "n", desired: {}, observed: o, fleet: [], authority: null });
const keys = (o: Observed) => findings(o).map((f) => f.key);

describe("models area", () => {
  it("is quiet when everything is in place", () => {
    expect(keys(observed({ stats: healthy }))).toEqual([]);
  });
  it("says nothing when [models] is off", () => {
    expect(keys(observed({ on: false, service: { installed: null, want: null, running: false }, providers: [] }))).toEqual([]);
  });
  it("reports a missing, stale or silent service with a safe fix", () => {
    for (const service of [
      { installed: null, want: "unit", running: false },
      { installed: "old", want: "unit", running: true },
      { installed: "unit", want: "unit", running: false },
    ]) {
      const [finding] = findings(observed({ service, stats: healthy }));
      expect(finding?.key).toBe("models-service");
      expect(finding?.fix?.safe).toBe(true);
    }
    expect(keys(observed({ stats: null }))).toEqual(["models-service"]);
  });
  it("reports each launcher that is missing or out of date", () => {
    const codex = { ...claudeProvider, instanceId: "codex", driver: "codex", binaryPath: "/h/.local/bin/fleetx-codex", launcher: { path: "/h/.local/bin/fleetx-codex", installed: null, want: "y" }, token: null };
    expect(keys(observed({ stats: healthy, providers: [{ ...claudeProvider, launcher: { ...LAUNCHER, installed: null } }, codex] }))).toEqual([
      "models-launcher-claudeAgent",
      "models-launcher-codex",
    ]);
  });
  it("routes a provider once its launcher is in place, never before", () => {
    const direct = { ...claudeProvider, binaryPath: "claude" };
    const ready = findings(observed({ stats: healthy, providers: [direct] }));
    expect(ready.map((f) => f.key)).toEqual(["models-not-routed-claudeAgent"]);
    expect(ready[0]?.fix).toEqual({ command: "fleetx models route claudeAgent", safe: false });
    const missing = findings(observed({ stats: healthy, providers: [{ ...direct, launcher: { ...LAUNCHER, installed: null } }] }));
    expect(missing.find((f) => f.key === "models-not-routed-claudeAgent")?.fix).toBeUndefined();
  });
  it("notes a provider it cannot route", () => {
    const [note] = findings(observed({ stats: healthy, providers: [{ ...claudeProvider, instanceId: "cursor", driver: "cursor", launcher: null, upstream: null, token: null, unroutable: "an SDK provider" }] }));
    expect(note).toMatchObject({ key: "models-unroutable-cursor", severity: "info", detail: "an SDK provider" });
  });
  it("asks for each provider's long-lived token, with its own help", () => {
    const [missing] = findings(observed({ stats: healthy, providers: [{ ...claudeProvider, token: { ...claudeProvider.token, set: false } }] }));
    expect(missing?.key).toBe("provider-token-missing-claudeAgent");
    expect(missing?.detail).toContain("claude setup-token");
    expect(missing?.detail).toContain("fleetx secrets set CLAUDE_CODE_OAUTH_TOKEN=<token>");
  });
  it("warns above 5% failures in the last hour, naming the class, or on fallbacks", () => {
    const bad: ModelProxyStats = { ...healthy, upstreams: [{ ...healthy.upstreams[0]!, h1: window(100, 6, { "529": 5, connect: 1 }) }] };
    const [failing] = findings(observed({ stats: bad }));
    expect(failing?.key).toBe("models-failing");
    expect(failing?.detail).toContain("mostly 529");
    const edge: ModelProxyStats = { ...healthy, upstreams: [{ ...healthy.upstreams[0]!, h1: window(100, 5) }] };
    expect(keys(observed({ stats: edge }))).toEqual([]);
    expect(keys(observed({ stats: healthy, fallbacksH1: 2 }))).toEqual(["models-failing"]);
  });
});

describe("provider logins and health", () => {
  const login = (over: Partial<ProviderAuth>): ProviderAuth => ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    auth: "authenticated",
    method: null,
    label: null,
    status: "ready",
    detail: "",
    checkedAt: null,
    source: "t3",
    ...over,
  });
  const obs = (providerAuth: ReadonlyArray<ProviderAuth>, access: MachineObservation["t3"]["access"] = null) =>
    ({
      protocol: 5,
      hostname: "h",
      platform: "linux",
      arch: "x64",
      user: "u",
      observedAt: 0,
      agents: [],
      t3: { runtime: null, descriptor: null, installedVersion: null, runtimeBinary: null, serverPath: null, providers: [], access, problems: ["x"] },
      providerAuth,
      proxy: null,
      areas: {},
      lastSync: null,
    }) satisfies MachineObservation;
  const result = (observation: MachineObservation): NodeResult => ({
    node: { name: "n", ssh: null, roles: ["member"], profiles: [], tailnet: null, settings: { table: {}, provenance: new Map() } },
    ok: true,
    observation,
    ms: 1,
  });
  const found = (o: MachineObservation) =>
    diagnose([result(o)], { agents: { claude: null, codex: null }, t3: {} }, {}, [], []).filter((f) => f.area === "providers" || f.key === "t3-access");

  it("makes any logged-out provider an error, with that provider's help", () => {
    const out = found(obs([login({ auth: "unauthenticated", detail: "not logged in" }), login({ instanceId: "opencode", driver: "opencode", auth: "unauthenticated", detail: "Sign in required" })]));
    expect(out.map((f) => [f.key, f.severity])).toEqual([
      ["provider-logged-out-claudeAgent", "error"],
      ["provider-logged-out-opencode", "error"],
    ]);
    expect(out[0]?.detail).toContain("claude setup-token");
    expect(out[1]?.detail).toContain("T3's provider settings");
  });
  it("passes on T3's warning or error with its message, and ignores disabled providers", () => {
    const out = found(obs([login({ instanceId: "codex", driver: "codex", status: "warning", detail: "Codex update available" }), login({ instanceId: "pi", enabled: false, auth: "unauthenticated" })]));
    expect(out).toMatchObject([{ key: "provider-unhealthy-codex", severity: "warn", detail: "Codex update available" }]);
  });
  it("is silent when logged in or unknown", () => {
    expect(found(obs([login({}), login({ auth: "unknown" })]))).toEqual([]);
  });
  it("offers to connect fleetx to T3 when it has no token", () => {
    const [f] = found(obs([], { state: "none", expiresAt: null, detail: "fleetx has no T3 token here", cli: true }));
    expect(f).toMatchObject({ key: "t3-access", severity: "warn", fix: { command: "fleetx t3 connect", safe: false } });
    const [noCli] = found(obs([], { state: "rejected", expiresAt: 1, detail: "T3 refused fleetx's token", cli: false }));
    expect(noCli?.fix).toBeUndefined();
    expect(found(obs([], { state: "ok", expiresAt: 1, detail: "", cli: true }))).toEqual([]);
  });
});
