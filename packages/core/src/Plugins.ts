/**
 * Plugin areas: modules in the user's config repo that add areas without
 * changing T3 Fleet.
 *
 *   [plugins]
 *   areas = ["plugins/brew.mjs"]       # relative to the config repo
 *
 * A plugin is plain JavaScript exporting a function that receives the kit and
 * returns an area (see Area.ts):
 *
 *   export default ({ defineArea, Effect, Schema, exec }) => defineArea({ id: "brew", … })
 *
 * The kit carries everything an area needs, so a plugin imports nothing and
 * runs wherever T3 Fleet runs, including on nodes over ssh, where the plugin
 * file comes from that node's clone of the config repo.
 */
import { pathToFileURL } from "node:url";

import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { defineArea, sh, shPath, type AnyArea } from "./Area.ts";
import { AREAS } from "./Areas.ts";
import { expandHome } from "./Config.ts";
import { exec } from "./Exec.ts";

export const pluginKit = { defineArea, sh, shPath, expandHome, exec, Effect, Schema, Option, Duration, FileSystem, Path } as const;
export type PluginKit = typeof pluginKit;

/** Why a thrown value or failure stopped something, in one line. */
export const why = (error: unknown): string =>
  Cause.isUnknownError(error) && error.cause !== undefined
    ? why(error.cause)
    : ((error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 240) ?? "");

/** A plugin that did not load, keyed by its path in the config repo. */
export interface PluginProblem {
  readonly plugin: string;
  readonly title: string;
}

/**
 * The built-in areas plus the plugins listed, loaded from `checkout`. A plugin
 * that fails to load (or whose function throws) is reported, not fatal.
 */
export const loadAreas = (checkout: string, plugins: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const areas: Array<AnyArea> = [...AREAS];
    const problems: Array<PluginProblem> = [];
    for (const rel of plugins) {
      const url = pathToFileURL(path.resolve(checkout, rel)).href;
      const loaded = yield* Effect.tryPromise(() => import(url) as Promise<{ default?: unknown }>).pipe(Effect.result);
      if (loaded._tag === "Failure") {
        problems.push({ plugin: rel, title: `plugin ${rel} cannot load: ${why(loaded.failure)}` });
        continue;
      }
      const factory = loaded.success.default;
      if (typeof factory !== "function") {
        problems.push({ plugin: rel, title: `plugin ${rel} cannot load: it must export a default function` });
        continue;
      }
      const made = yield* Effect.try(() => (factory as (kit: PluginKit) => AnyArea | undefined)(pluginKit)).pipe(Effect.result);
      if (made._tag === "Failure") {
        problems.push({ plugin: rel, title: `plugin ${rel} failed while making its area: ${why(made.failure)}` });
        continue;
      }
      const area = made.success;
      if (typeof area?.id !== "string" || areas.some((a) => a.id === area.id)) {
        problems.push({ plugin: rel, title: `plugin ${rel} has no area id, or one that is already taken` });
        continue;
      }
      areas.push(area);
    }
    return { areas, problems };
  });
