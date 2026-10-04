/** Helpers every command shares. */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";

import type { CheckReport } from "@t3-fleet/core/Check";
import { loadConfig } from "@t3-fleet/core/Config";
import { newBuild } from "@t3-fleet/core/Runtime";

/**
 * The bundle that gets streamed to other machines. Running from dist/bin.mjs
 * it is this file; running from source it is the last build.
 */
export const ownBundle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const self = yield* path.fromFileUrl(new URL(import.meta.url));
  const bundle = self.endsWith(".mjs") ? self : path.join(path.dirname(self), "../dist/bin.mjs");
  return yield* fs.readFileString(bundle).pipe(
    Effect.mapError(() => `no bundle at ${bundle}; run \`pnpm build\` first`),
  );
});


export const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));


/**
 * Every machine is always observed, because parity findings need all of
 * them; --node only narrows what is shown and fixed.
 */
export const prepare = (only: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const config = yield* loadConfig;
    const unknown = only.filter((name) => !config.nodes.some((n) => n.name === name));
    if (unknown.length > 0) {
      return yield* Effect.fail(`unknown machine: ${unknown.join(", ")} (known: ${config.nodes.map((n) => n.name).join(", ")})`);
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
export const isUserError = (error: unknown): error is string | { readonly _tag: "ConfigError" | "SecretsError"; readonly message: string } =>
  typeof error === "string" ||
  (typeof error === "object" && error !== null && "_tag" in error && (error._tag === "ConfigError" || error._tag === "SecretsError"));

export const userMessage = (error: unknown): string =>
  typeof error === "string" ? error : isUserError(error) && typeof error !== "string" ? error.message : String(error);

/** User errors print one line and exit 1; anything else is a bug and keeps its trace. */
export const reportUserErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(isUserError, (error) =>
      Console.error(`T3 Fleet: ${userMessage(error)}`).pipe(
        Effect.andThen(Effect.sync(() => {
          process.exitCode = 1;
        })),
      ),
    ),
  );

export const nodeFlag = Flag.String("node").pipe(
  Flag.withDescription("Only this machine (repeatable)."),
  Flag.atLeast(0),
);

/**
 * Runs a long-running service until it stops or this bundle is replaced by a
 * new build; then it returns, the process exits, and its unit starts the new
 * build (see newBuild in Runtime.ts).
 */
export const untilNewBuild = <A, E, R>(service: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(
    service,
    newBuild(process.argv[1] ?? "").pipe(Effect.flatMap(() => Console.log("a new T3 Fleet build is installed; exiting so the service restarts on it"))),
  );
