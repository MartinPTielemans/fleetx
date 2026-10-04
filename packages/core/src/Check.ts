/**
 * One full check: every node observed in parallel, the latest releases looked
 * up, findings derived. `status`, `fix` and the MCP server all start here, so
 * they always agree on what is wrong.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { buildOf } from "./Build.ts";
import { diagnose, type Finding } from "./Diagnose.ts";
import { probeSettings, type Config } from "./Config.ts";
import { sha256 } from "./Hash.ts";
import { loadAreas } from "./Plugins.ts";
import { lookupLatest, type Latest } from "./Latest.ts";
import { applyAccepted } from "./Memory.ts";
import { observeNode, type NodeResult } from "./Remote.ts";

export interface CheckReport {
  readonly results: ReadonlyArray<NodeResult>;
  readonly latest: Latest;
  readonly findings: ReadonlyArray<Finding>;
  readonly elapsedMs: number;
}

export const checkNodes = (config: Config, bundle: string) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const engine = bundle === "" ? undefined : yield* Effect.promise(() => sha256(bundle));
    const build = bundle === "" ? null : buildOf(bundle);
    const results = yield* Effect.forEach(
      config.nodes,
      (n) => observeNode(n, bundle, probeSettings(config, n, engine, build), engine),
      {
        concurrency: "unbounded",
      },
    );
    const t3Versions = results
      .flatMap((r) =>
        r.ok
          ? [r.observation.t3.descriptor?.serverVersion ?? r.observation.t3.installedVersion ?? ""]
          : [],
      )
      .filter((v) => v !== "");
    const latest = yield* lookupLatest(t3Versions);
    const { areas } = yield* loadAreas(config.repo, config.settings.plugins?.areas ?? []);
    const findings = applyAccepted(
      diagnose(results, latest, config.settings, config.nodes, areas),
      config.settings.accept,
    );
    return {
      results,
      latest,
      findings,
      elapsedMs: (yield* Clock.currentTimeMillis) - started,
    } satisfies CheckReport;
  });
