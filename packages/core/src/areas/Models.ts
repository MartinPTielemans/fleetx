/**
 * The model proxy on every node (docs/design/companion.md, "models"):
 *
 *   [models]
 *   egress = "direct"                    # or "relay"
 *   [models.upstreams.<name>]            # beyond the built-in anthropic and openai
 *   [models.providers.<instanceId>]      # per T3 instance: upstream, env, args, token_env, route
 *
 * (Recipes.ts has the full settings.) With [models] on, the node runs `T3 Fleet
 * models serve` as a service, has a launcher per routable T3 provider
 * instance, and T3 starts each one through its launcher. Claude and Codex
 * route out of the box; another driver routes once its recipe is declared;
 * one that cannot be routed is a note. The proxy's own stats travel in the
 * observation, so `status --all` and the UI see them.
 *
 * Provider logins are checked by the core probe from T3's own snapshot on
 * every node, with or without [models] (`provider-logged-out-<instance>`, in
 * Diagnose.ts); this area says when a provider's long-lived credential, which
 * prevents logouts, is missing from the fleet's secrets.
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
  findCli,
  launcherInstall,
  launcherText,
  SERVICE_LABEL,
  SERVICE_UNIT,
  serviceInstall,
  serviceUnitPath,
  serviceUnitText,
} from "../models/Launchers.ts";
import { fetchStats } from "../models/Proxy.ts";
import {
  launcherPath,
  ModelsSettings,
  providerName,
  resolveRecipe,
  upstreamsOf,
} from "../models/Recipes.ts";
import { loadFallbacks, WINDOWS } from "../models/Stats.ts";

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
  /** Each enabled T3 instance [models] does not exclude. */
  providers: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      driver: Schema.String,
      /** As T3's settings have it. */
      binaryPath: Schema.NullOr(Schema.String),
      upstream: Schema.NullOr(Schema.String),
      /** Its launcher, when it has a recipe. */
      launcher: Schema.NullOr(
        Schema.Struct({
          path: Schema.String,
          installed: Schema.NullOr(Schema.String),
          want: Schema.String,
          /** The CLI it would run, and whether that is there (absent from older builds: assumed there). */
          cli: Schema.optionalKey(Schema.Struct({ command: Schema.String, found: Schema.Boolean })),
        }),
      ),
      /** Why it cannot be routed; null when it can. */
      unroutable: Schema.NullOr(Schema.String),
      /** Its long-lived credential, when the recipe has one. */
      token: Schema.NullOr(
        Schema.Struct({ env: Schema.String, set: Schema.Boolean, help: Schema.String }),
      ),
    }),
  ),
  /** Launches that ran a CLI directly in the last hour (from the launchers' log). */
  fallbacksH1: Schema.Number,
  /** The proxy's /stats; null when nothing answers on its port. */
  stats: Schema.NullOr(ModelProxyStats),
});
type Observed = typeof Observed.Type;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const tilde = (path: string) =>
  path.replace(/^\/(Users|home)\/[^/]+\//, "~/").replace(/^\/root\//, "~/");

/** Whether T3's configured binary for an instance is its launcher (absolute, ~, or a bare name on PATH). */
export const isRouted = (binaryPath: string | null, launcher: string) =>
  binaryPath !== null && basename(binaryPath) === basename(launcher);

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
      const now = yield* Clock.currentTimeMillis;
      const stats = yield* fetchStats();
      const fallbacksH1 = (yield* loadFallbacks(ctx.home, now)).filter(
        (f) => f.at >= now - WINDOWS.h1,
      ).length;
      const base = { on: desired !== undefined, platform, root, fallbacksH1, stats };
      if (desired === undefined)
        return {
          ...base,
          service: { installed: null, want: null, running: false },
          providers: [],
        } satisfies Observed;
      const read = (p: string) =>
        fs.readFileString(p).pipe(Effect.option, Effect.map(Option.getOrNull));

      const want = serviceUnitText(
        platform,
        root,
        ctx.home,
        yield* stableNode(ctx.home),
        yield* installedBundle(ctx.home),
        desired.egress ?? "direct",
      );
      const check =
        platform === "darwin"
          ? yield* exec({
              command: "launchctl",
              args: ["print", `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`],
              timeout: Duration.seconds(5),
            })
          : yield* exec({
              command: "systemctl",
              args: [
                ...(root ? [] : ["--user"]),
                "is-active",
                "--quiet",
                `${SERVICE_UNIT}.service`,
              ],
              timeout: Duration.seconds(5),
            });
      const running =
        platform === "darwin"
          ? check.code === 0 && /state = running/.test(check.stdout)
          : check.code === 0;
      const service = {
        installed: yield* read(serviceUnitPath(platform, root, ctx.home)),
        want,
        running,
      };

      const settings = yield* readT3Settings(ctx.home);
      const plans =
        Option.isSome(settings) && settings.value !== "invalid"
          ? providerPlans(settings.value)
          : [];
      const upstreams = upstreamsOf(desired);
      const secrets = (yield* read(localSecretsPath(ctx.home))) ?? "";
      const providers: Array<Observed["providers"][number]> = [];
      for (const plan of plans.filter((p) => p.enabled)) {
        const resolved = resolveRecipe(plan.instanceId, plan.driver, desired, upstreams);
        if (resolved._tag === "skip") continue;
        const common = {
          instanceId: plan.instanceId,
          driver: plan.driver,
          binaryPath: plan.binaryPath,
        };
        if (resolved._tag === "unroutable") {
          providers.push({
            ...common,
            upstream: null,
            launcher: null,
            unroutable: resolved.reason,
            token: null,
          });
          continue;
        }
        const { recipe } = resolved;
        const path = launcherPath(ctx.home, plan.instanceId);
        const tokenEnv = recipe.tokenEnv;
        providers.push({
          ...common,
          upstream: recipe.upstream,
          launcher: {
            path,
            installed: yield* read(path),
            want: launcherText(plan.instanceId, recipe),
            cli: {
              command: recipe.command,
              found: (yield* findCli(ctx.home, recipe.command, ctx.env["PATH"] ?? "")) !== null,
            },
          },
          unroutable: null,
          token:
            tokenEnv === null
              ? null
              : {
                  env: tokenEnv,
                  set: hasVar(secrets, tokenEnv) || (ctx.env[tokenEnv] ?? "") !== "",
                  help: recipe.tokenHelp,
                },
        });
      }
      return { ...base, service, providers } satisfies Observed;
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (!observed.on) return out;
    const base = { node, area: "models" as const };

    const { service } = observed;
    if (
      service.want !== null &&
      (service.installed !== service.want || !service.running || observed.stats === null)
    ) {
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
        fix: {
          command: serviceInstall(observed.platform, observed.root, service.want),
          safe: true,
        },
      });
    }

    for (const p of observed.providers) {
      const name = providerName(p.instanceId);
      if (p.unroutable !== null) {
        out.push({
          ...base,
          key: `models-unroutable-${p.instanceId}`,
          severity: "info",
          title: `${name} is not routed through the model proxy`,
          detail: p.unroutable,
        });
        continue;
      }
      const launcher = p.launcher;
      if (launcher === null) continue;
      const ready = launcher.installed === launcher.want;
      if (!ready) {
        out.push({
          ...base,
          key: `models-launcher-${p.instanceId}`,
          severity: "warn",
          title: `${tilde(launcher.path)} is ${launcher.installed === null ? "missing" : "out of date"}`,
          fix: { command: launcherInstall(basename(launcher.path), launcher.want), safe: true },
        });
      }
      if (!isRouted(p.binaryPath, launcher.path)) {
        // The launcher runs the recipe's CLI, not T3's binaryPath: routing to a CLI that is not there would break the provider.
        const cli = launcher.cli;
        out.push({
          ...base,
          key: `models-not-routed-${p.instanceId}`,
          severity: "warn",
          title: `T3 starts ${name} directly, not through the model proxy`,
          ...(cli !== undefined && !cli.found
            ? {
                detail: `${basename(launcher.path)} would run ${cli.command}, which is not installed here (nor ${basename(cli.command)} on PATH); set [models.providers.${p.instanceId}] command`,
              }
            : ready
              ? {
                  detail: `points T3's ${name} at ${basename(launcher.path)}; sessions already running keep their binary`,
                  fix: { command: `t3-fleet models route ${sh(p.instanceId)}`, safe: false },
                }
              : { detail: `install ${basename(launcher.path)} first` }),
        });
      }
      if (p.token !== null && !p.token.set) {
        out.push({
          ...base,
          key: `provider-token-missing-${p.instanceId}`,
          severity: "warn",
          title: `no ${p.token.env} in this machine's secrets, so ${name} keeps a login that can expire`,
          detail: `${p.token.help}; then on an authority \`t3-fleet secrets set ${p.token.env}=<token>\``,
        });
      }
    }

    const failing = modelsFailing(observed);
    if (failing !== null)
      out.push({
        ...base,
        key: "models-failing",
        severity: "warn",
        title: failing.title,
        detail: failing.detail,
      });
    return out;
  },
});

/** Fewer failures than this in an hour are noise, whatever share of a quiet hour's traffic they are. */
const MIN_FAILURES = 3;

/**
 * More than 5% of the last hour's requests failed (and at least MIN_FAILURES),
 * or launches fell back to the CLI; null when traffic is healthy. Client
 * errors ("4xx": a prompt too long, a request too large) are the request's
 * own problem and do not count.
 */
export const modelsFailing = (
  observed: Pick<Observed, "stats" | "fallbacksH1">,
): { title: string; detail: string } | null => {
  const parts: Array<string> = [];
  const details: Array<string> = [];
  for (const u of observed.stats?.upstreams ?? []) {
    const w = u.h1;
    const failures = Object.entries(w.failures).filter(([k]) => k !== "4xx");
    const failed = failures.reduce((n, [, v]) => n + v, 0);
    if (failed < MIN_FAILURES || failed / w.requests <= 0.05) continue;
    const [worst] = failures.sort((a, b) => b[1] - a[1]);
    parts.push(`${u.upstream}: ${failed} of ${w.requests} requests failed in the last hour`);
    details.push(
      `${u.upstream} mostly ${worst?.[0] ?? "unknown"}${u.lastError === null ? "" : `; last: ${u.lastError.message}`}`,
    );
  }
  const fallbacks = Math.max(
    observed.fallbacksH1,
    ...(observed.stats?.upstreams ?? []).map((u) => u.h1.fallbacks),
  );
  if (fallbacks > 0) {
    parts.push(
      `${fallbacks} launch${fallbacks === 1 ? "" : "es"} skipped the proxy in the last hour`,
    );
    details.push("the proxy was not listening (~/.local/state/t3-fleet/models-fallback.log)");
  }
  return parts.length === 0 ? null : { title: parts.join("; "), detail: details.join("; ") };
};
