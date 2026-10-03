/**
 * The model proxy on every node (docs/design/companion.md, "models"):
 *
 *   [models]
 *   providers = ["claudeAgent", "codex"]          # T3 instances routed through it
 *   claude_token_env = "CLAUDE_CODE_OAUTH_TOKEN"  # the secret holding a setup-token
 *   egress = "direct"                             # or "relay"
 *
 * With [models] on, the node runs `fleetx models serve` as a service, has the
 * fleetx-claude and fleetx-codex launchers, and T3 starts each listed
 * provider through its launcher. The area also reports traffic: the proxy's
 * own stats travel in the observation, so `status --all` and the UI see them.
 *
 * Claude's login is checked by the core probe on every node, with or without
 * [models] (`claude-logged-out`, in Diagnose.ts); this area only says when the
 * setup-token that prevents logouts is missing.
 *
 * Routing is offered once the launcher is in place. It is safe even while
 * the proxy is down, because a launcher then runs the CLI directly.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ModelProxyStats } from "../Api.ts";
import { defineArea, sh } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { installedBundle, stableNode } from "../Runtime.ts";
import { localSecretsPath } from "../Secrets.ts";
import { providerPlans, readT3Settings } from "../T3Settings.ts";
import {
  launcherForDriver,
  launcherInstall,
  launcherPath,
  launcherText,
  SERVICE_LABEL,
  SERVICE_UNIT,
  serviceInstall,
  serviceUnitPath,
  serviceUnitText,
} from "../models/Launchers.ts";
import { fetchStats } from "../models/Proxy.ts";
import { loadFallbacks, WINDOWS } from "../models/Stats.ts";

export const DEFAULT_PROVIDERS = ["claudeAgent", "codex"];
export const DEFAULT_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

export const ModelsSettings = Schema.Struct({
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  claude_token_env: Schema.optionalKey(Schema.String),
  egress: Schema.optionalKey(Schema.Literals(["direct", "relay"])),
});
export type ModelsSettings = typeof ModelsSettings.Type;

const Desired = Schema.UndefinedOr(ModelsSettings);

const Observed = Schema.Struct({
  /** Whether [models] is set for this node. */
  on: Schema.Boolean,
  platform: Schema.String,
  root: Schema.Boolean,
  service: Schema.Struct({
    installed: Schema.NullOr(Schema.String),
    want: Schema.NullOr(Schema.String),
    /** The service manager has it running. */
    running: Schema.Boolean,
  }),
  launchers: Schema.Array(
    Schema.Struct({ name: Schema.Literals(["claude", "codex"]), path: Schema.String, installed: Schema.NullOr(Schema.String), want: Schema.String }),
  ),
  /** The listed T3 instances, as T3's settings have them. */
  providers: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      driver: Schema.String,
      enabled: Schema.Boolean,
      binaryPath: Schema.NullOr(Schema.String),
      launcher: Schema.NullOr(Schema.String),
    }),
  ),
  tokenEnv: Schema.String,
  /** The setup-token secret is in this node's secrets.env. */
  tokenSet: Schema.Boolean,
  /** Launches that ran a CLI directly in the last hour (from the launchers' log). */
  fallbacksH1: Schema.Number,
  /** The proxy's /stats; null when nothing answers on its port. */
  stats: Schema.NullOr(ModelProxyStats),
});
type Observed = typeof Observed.Type;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether T3's configured binary for an instance is its launcher (absolute, ~, or a bare name on PATH). */
export const isRouted = (binaryPath: string | null, launcher: string) => binaryPath !== null && basename(binaryPath) === basename(launcher);

const hasVar = (text: string, name: string) =>
  text.split("\n").some((l) => {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}=(.*)$`).exec(l);
    return m !== null && (m[1] ?? "").replace(/^"(.*)"$/, "$1").trim() !== "";
  });

export const ModelsArea = defineArea({
  id: "models",
  description: "the model proxy on every node, its launchers, and T3's providers routed through it",
  desired: Desired,
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = process.platform;
      const root = process.getuid?.() === 0;
      const tokenEnv = desired?.claude_token_env ?? DEFAULT_TOKEN_ENV;
      const now = yield* Clock.currentTimeMillis;
      const stats = yield* fetchStats();
      const fallbacksH1 = (yield* loadFallbacks(ctx.home, now)).filter((f) => f.at >= now - WINDOWS.h1).length;
      const base = { on: desired !== undefined, platform, root, tokenEnv, fallbacksH1, stats };
      if (desired === undefined) {
        return { ...base, service: { installed: null, want: null, running: false }, launchers: [], providers: [], tokenSet: false } satisfies Observed;
      }
      const read = (p: string) => fs.readFileString(p).pipe(Effect.option, Effect.map(Option.getOrNull));

      const egress = desired.egress ?? "direct";
      const want = serviceUnitText(platform, root, ctx.home, yield* stableNode(ctx.home), yield* installedBundle(ctx.home), egress);
      const check =
        platform === "darwin"
          ? yield* exec({ command: "launchctl", args: ["print", `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`], timeout: Duration.seconds(5) })
          : yield* exec({ command: "systemctl", args: [...(root ? [] : ["--user"]), "is-active", "--quiet", `${SERVICE_UNIT}.service`], timeout: Duration.seconds(5) });
      const running = platform === "darwin" ? check.code === 0 && /state = running/.test(check.stdout) : check.code === 0;
      const service = { installed: yield* read(serviceUnitPath(platform, root, ctx.home)), want, running };

      const listed = desired.providers ?? DEFAULT_PROVIDERS;
      const settings = yield* readT3Settings(ctx.home);
      const plans = Option.isSome(settings) && settings.value !== "invalid" ? providerPlans(settings.value) : [];
      const providers = plans
        .filter((p) => listed.includes(p.instanceId))
        .map((p) => {
          const name = launcherForDriver(p.driver);
          return { instanceId: p.instanceId, driver: p.driver, enabled: p.enabled, binaryPath: p.binaryPath, launcher: name === null ? null : launcherPath(ctx.home, name) };
        });
      const names = [...new Set(providers.flatMap((p) => { const n = launcherForDriver(p.driver); return n === null ? [] : [n]; }))].sort();
      const launchers = yield* Effect.forEach(names, (name) =>
        Effect.map(read(launcherPath(ctx.home, name)), (installed) => ({ name, path: launcherPath(ctx.home, name), installed, want: launcherText(name, tokenEnv) })),
      );
      const secrets = yield* read(localSecretsPath(ctx.home));
      const tokenSet = (secrets !== null && hasVar(secrets, tokenEnv)) || (ctx.env[tokenEnv] ?? "") !== "";
      return { ...base, service, launchers, providers, tokenSet } satisfies Observed;
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (!observed.on) return out;
    const base = { node, area: "models" as const };

    const { service } = observed;
    if (service.want !== null && (service.installed !== service.want || !service.running || observed.stats === null)) {
      out.push({
        ...base,
        key: "models-service",
        severity: "warn",
        title:
          service.installed === null
            ? "the model proxy is not installed"
            : service.installed !== service.want
              ? "the model proxy's service is out of date"
              : !service.running
                ? "the model proxy is not running"
                : "the model proxy runs but does not answer on 127.0.0.1:8398",
        detail: "until it runs, the launchers start the CLIs directly",
        fix: { command: serviceInstall(observed.platform, observed.root, service.want), safe: true },
      });
    }

    for (const launcher of observed.launchers) {
      if (launcher.installed === launcher.want) continue;
      out.push({
        ...base,
        key: "models-launcher",
        severity: "warn",
        title: `${launcher.path.replace(/^\/(Users|home)\/[^/]+\//, "~/")} is ${launcher.installed === null ? "missing" : "out of date"}`,
        fix: { command: launcherInstall(launcher.name, launcher.want), safe: true },
      });
    }

    const notRouted = observed.providers.filter((p) => p.enabled && p.launcher !== null && !isRouted(p.binaryPath, p.launcher));
    for (const p of notRouted) {
      const launcher = observed.launchers.find((l) => l.path === p.launcher);
      const ready = launcher !== undefined && launcher.installed === launcher.want;
      const label = p.instanceId === "claudeAgent" ? "claude" : p.instanceId;
      out.push({
        ...base,
        key: `models-not-routed-${p.instanceId}`,
        severity: "warn",
        title: `T3 starts ${label} directly, not through the model proxy`,
        ...(ready
          ? {
              detail: `points T3's ${label} at ${basename(launcher.path)}; sessions already running keep their binary`,
              fix: { command: `fleetx models route ${sh(p.instanceId)}`, safe: false },
            }
          : { detail: `install ${basename(p.launcher ?? "")} first (models-launcher)` }),
      });
    }

    const claude = observed.providers.some((p) => p.driver === "claudeAgent" && p.enabled);
    if (claude && !observed.tokenSet) {
      out.push({
        ...base,
        key: "claude-token-missing",
        severity: "warn",
        title: `no ${observed.tokenEnv} in this machine's secrets, so Claude keeps a login that can expire`,
        detail: `run \`claude setup-token\` once, then on an authority \`fleetx secrets set ${observed.tokenEnv}=<token>\``,
      });
    }

    const failing = modelsFailing(observed);
    if (failing !== null) out.push({ ...base, key: "models-failing", severity: "warn", title: failing.title, detail: failing.detail });
    return out;
  },
});

/** More than 5% of the last hour's requests failed, or launches fell back to the CLI; null when traffic is healthy. */
export const modelsFailing = (observed: Pick<Observed, "stats" | "fallbacksH1">): { title: string; detail: string } | null => {
  const parts: Array<string> = [];
  const details: Array<string> = [];
  for (const u of observed.stats?.upstreams ?? []) {
    const w = u.h1;
    if (w.requests === 0 || w.failed / w.requests <= 0.05) continue;
    const [worst] = Object.entries(w.failures).sort((a, b) => b[1] - a[1]);
    parts.push(`${u.upstream}: ${w.failed} of ${w.requests} requests failed in the last hour`);
    details.push(`${u.upstream} mostly ${worst?.[0] ?? "unknown"}${u.lastError === null ? "" : `; last: ${u.lastError.message}`}`);
  }
  const fallbacks = Math.max(observed.fallbacksH1, ...(observed.stats?.upstreams ?? []).map((u) => u.h1.fallbacks));
  if (fallbacks > 0) {
    parts.push(`${fallbacks} launch${fallbacks === 1 ? "" : "es"} skipped the proxy in the last hour`);
    details.push("the proxy was not listening (~/.local/state/fleetx/models-fallback.log)");
  }
  return parts.length === 0 ? null : { title: parts.join("; "), detail: details.join("; ") };
};
