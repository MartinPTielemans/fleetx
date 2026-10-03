/**
 * Plugin areas: modules in the user's config repo that add areas without
 * changing fleetx.
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
 * runs wherever fleetx runs, including on nodes over ssh, where the plugin
 * file comes from that node's clone of the config repo.
 */
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

/** The built-in areas plus the plugins listed, loaded from `checkout`. A plugin that fails to load is reported, not fatal. */
export const loadAreas = (checkout: string, plugins: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const areas: Array<AnyArea> = [...AREAS];
    const problems: Array<string> = [];
    for (const rel of plugins) {
      const file = `${checkout.replace(/\/+$/, "")}/${rel}`;
      const loaded = yield* Effect.tryPromise(() => import(`file://${file}`) as Promise<{ default?: unknown }>).pipe(Effect.option);
      const factory = Option.getOrUndefined(loaded)?.default;
      if (typeof factory !== "function") {
        problems.push(`plugin ${rel}: cannot load (it must export a default function)`);
        continue;
      }
      const area = (factory as (kit: PluginKit) => AnyArea)(pluginKit);
      if (typeof area?.id !== "string" || areas.some((a) => a.id === area.id)) {
        problems.push(`plugin ${rel}: no area id, or one that is already taken`);
        continue;
      }
      areas.push(area);
    }
    return { areas, problems };
  });
