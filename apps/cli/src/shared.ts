/** Helpers every command shares. */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";

import { ENGINE_INSTALL } from "@t3-fleet/core/areas/Engine";
import type { CheckReport } from "@t3-fleet/core/Check";
import { loadConfig, type Config } from "@t3-fleet/core/Config";
import type { Finding, Fix } from "@t3-fleet/core/Diagnose";
import { runFixes, type FixOutcome } from "@t3-fleet/core/Fix";
import { newBuild, untilReplaced } from "@t3-fleet/core/Runtime";

/**
 * Where the bundle is, given the file this code runs from: that file, when it
 * is the bundle, under whatever name it was installed (dist/bin.mjs, or
 * ~/.local/bin/t3-fleet); the last build, when it is TypeScript source.
 */
export const bundleFor = (self: string, join: (...parts: Array<string>) => string) =>
  /\.[cm]?tsx?$/.test(self) ? join(self, "../../dist/bin.mjs") : self;

/** The bundle that gets streamed to other machines: this one, or the last build of this source. */
export const ownBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const self = yield* path.fromFileUrl(new URL(import.meta.url));
  const bundle = bundleFor(self, path.join);
  return yield* fs
    .readFileString(bundle)
    .pipe(Effect.mapError(() => `no bundle at ${bundle}; run \`pnpm build\` first`));
});

/**
 * What `t3-fleet fix` shows: the fixes to apply, the findings that need a
 * person, and the fixes `--safe` leaves out, each limited to `areas` (all
 * when empty).
 */
export const fixPlan = (
  findings: ReadonlyArray<Finding>,
  options: { readonly safe: boolean; readonly areas: ReadonlyArray<string> },
) => {
  const shown = findings.filter(
    (f) => options.areas.length === 0 || options.areas.includes(f.area),
  );
  return {
    fixes: shown.filter(
      (f): f is Finding & { readonly fix: Fix } =>
        f.fix !== undefined && (!options.safe || f.fix.safe),
    ),
    findings: shown,
    skipped: shown.filter((f) => f.fix !== undefined && options.safe && !f.fix.safe),
  };
};

export const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * The config and the build for a command that keeps running (`ui`, `mcp`).
 * The config is read again for every check, so edits to it show without a
 * restart. The build is the one this process started with; when another
 * replaces it on disk (an upgrade from a terminal), `stale` says so, and
 * this process must not install its build anywhere: it would put the old one
 * back. See withoutStaleInstalls and refuseStaleInstalls.
 */
export const liveController = Effect.gen(function* () {
  const started = yield* ownBundle.pipe(Effect.option);
  return Effect.gen(function* () {
    const config = yield* loadConfig;
    if (Option.isNone(started)) {
      const bundle = config.nodes.some((n) => n.ssh !== null) ? yield* ownBundle : "";
      return { config, bundle, stale: false };
    }
    const now = yield* ownBundle.pipe(Effect.option);
    return {
      config,
      bundle: started.value,
      stale: Option.isSome(now) && now.value !== started.value,
    };
  });
});

const staleDetail = (command: string) =>
  `a newer T3 Fleet build was installed after \`t3-fleet ${command}\` started; restart it to install builds from here`;

/** A stale controller's report: its build installs become notes on restarting it. */
export const withoutStaleInstalls = (
  report: CheckReport,
  stale: boolean,
  command: string,
): CheckReport =>
  !stale
    ? report
    : {
        ...report,
        findings: report.findings.map((f): Finding => {
          if (f.area !== "engine" || (f.key !== "engine-outdated" && f.key !== "engine-newer-here"))
            return f;
          const { fix: _fix, ...rest } = f;
          return { ...rest, detail: staleDetail(command) };
        }),
      };

/**
 * Applies fixes from a controller that keeps running, with the config as it
 * is now. A stale controller's build installs fail with the reason, and so
 * does every fix when the config cannot be read.
 */
export const applyLive = <E, R>(
  current: Effect.Effect<
    { readonly config: Config; readonly bundle: string; readonly stale: boolean },
    E,
    R
  >,
  fixes: ReadonlyArray<Finding & { readonly fix: Fix }>,
  command: string,
) =>
  current.pipe(
    Effect.flatMap(({ config, bundle, stale }) => {
      const refused = stale ? fixes.filter((f) => f.fix.command === ENGINE_INSTALL) : [];
      return runFixes(
        config.nodes,
        fixes.filter((f) => !refused.includes(f)),
        config.checkout,
        bundle,
        config.repo,
      ).pipe(
        Effect.map((outcomes) => [
          ...refused.map((finding): FixOutcome => ({
            finding,
            ok: false,
            summary: staleDetail(command),
          })),
          ...outcomes,
        ]),
      );
    }),
    Effect.catch((e) =>
      Effect.succeed(
        fixes.map((finding): FixOutcome => ({ finding, ok: false, summary: userMessage(e) })),
      ),
    ),
  );

/**
 * Every machine is always observed, because parity findings need all of
 * them; --node only narrows what is shown and fixed.
 */
export const prepare = (only: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const unknown = only.filter((name) => !config.nodes.some((n) => n.name === name));
    if (unknown.length > 0) {
      return yield* Effect.fail(
        `unknown machine: ${unknown.join(", ")} (known: ${config.nodes.map((n) => n.name).join(", ")})`,
      );
    }
    const bundle = config.nodes.some((n) => n.ssh !== null) ? yield* ownBundle : "";
    const shown = (name: string) => only.length === 0 || only.includes(name);
    return { config, nodes: config.nodes, bundle, shown };
  });

/** Narrow a report to the machines asked for. */
export const narrow = (report: CheckReport, shown: (name: string) => boolean): CheckReport => ({
  ...report,
  results: report.results.filter((r) => shown(r.node.name)),
  findings: report.findings.filter((f) => shown(f.node)),
});

/** A failure meant for the user rather than a bug: a sentence, or a typed config error. */
export const isUserError = (
  error: unknown,
): error is string | { readonly _tag: "ConfigError" | "SecretsError"; readonly message: string } =>
  typeof error === "string" ||
  (typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "ConfigError" || error._tag === "SecretsError"));

export const userMessage = (error: unknown): string =>
  typeof error === "string"
    ? error
    : isUserError(error) && typeof error !== "string"
      ? error.message
      : String(error);

/** User errors print one line and exit 1; anything else is a bug and keeps its trace. */
export const reportUserErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(isUserError, (error) =>
      Console.error(`T3 Fleet: ${userMessage(error)}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  );

export const nodeFlag = Flag.String("node").pipe(
  Flag.withDescription("Only this machine (repeatable)."),
  Flag.atLeast(0),
);

/**
 * Runs a long-running service until it stops or this bundle is replaced by a
 * new build (untilReplaced and newBuild in Runtime.ts). The exit is forced a
 * few seconds after: a client's open connection (a kept-alive socket, an
 * event stream) would otherwise keep the process alive with nothing
 * listening, and its unit would never start the new build. With `drain`, the
 * service keeps running once the new build is seen until `drain` completes.
 */
export const untilNewBuild = <A, E, R, R2 = never>(
  service: Effect.Effect<A, E, R>,
  options: { readonly drain?: Effect.Effect<unknown, never, R2> } = {},
) =>
  untilReplaced(service, newBuild(process.argv[1] ?? ""), {
    ...(options.drain === undefined ? {} : { drain: options.drain }),
    // A Node timer, not Effect.sleep: it has to fire after the runtime itself has finished.
    // @effect-diagnostics-next-line globalTimers:off
    exit: () => setTimeout(() => process.exit(0), 5_000).unref(),
  });
