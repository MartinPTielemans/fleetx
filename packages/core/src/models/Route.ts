/**
 * Pointing a T3 provider instance at its launcher: `fleetx models route
 * <instance>`, the fix for `models-not-routed`.
 *
 * T3 offers no CLI command for provider settings; its settings RPC needs an
 * authenticated WebSocket session. Its server watches settings.json and
 * reloads it on change (T3's own `t3 theme` edits the file the same way), so
 * this edits that one file: only the instance's binaryPath changes, the rest
 * is kept as parsed, and the result is written to a temporary file and
 * renamed into place.
 *
 *   providerInstances.<id>.config.binaryPath   when the instance is explicit
 *   providers.<driver>.binaryPath              for a built-in instance T3
 *                                              builds from the legacy block
 *
 * Creating an explicit instance would drop what T3 reads from the legacy
 * block (custom models and the like), so the legacy field is edited instead.
 * The first edit keeps a copy (settings.json.fleetx-models-backup, mode 600);
 * `--undo` puts back the binaryPath that copy has.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { T3_DRIVERS, t3SettingsPath } from "../T3Settings.ts";

export class RouteError extends Schema.TaggedError<RouteError>()("RouteError", { message: Schema.String }) {}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const prettyJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const parse = (text: string, what: string) =>
  decodeJson(text).pipe(
    Effect.mapError(() => new RouteError({ message: `${what} is not valid JSON` })),
    Effect.filterOrFail(isObject, () => new RouteError({ message: `${what} is not a JSON object` })),
  );

/** Where an instance's binaryPath lives in settings.json; null when T3 has no such instance. */
const locate = (settings: Json, instanceId: string): { readonly holder: () => Json; readonly current: string | null } | null => {
  const instances = settings["providerInstances"];
  const explicit = isObject(instances) ? instances[instanceId] : undefined;
  if (isObject(explicit)) {
    const config = explicit["config"];
    return {
      current: isObject(config) && typeof config["binaryPath"] === "string" ? config["binaryPath"] : null,
      holder: () => {
        if (!isObject(explicit["config"])) explicit["config"] = {};
        return explicit["config"] as Json;
      },
    };
  }
  if (T3_DRIVERS[instanceId] === undefined) return null;
  const providers = settings["providers"];
  const legacy = isObject(providers) ? providers[instanceId] : undefined;
  return {
    current: isObject(legacy) && typeof legacy["binaryPath"] === "string" ? legacy["binaryPath"] : null,
    holder: () => {
      if (!isObject(settings["providers"])) settings["providers"] = {};
      const all = settings["providers"] as Json;
      if (!isObject(all[instanceId])) all[instanceId] = {};
      return all[instanceId] as Json;
    },
  };
};

/** The edited settings text; pure, for tests. `binaryPath` null removes the field (T3's default applies). */
export const withBinaryPath = (text: string, instanceId: string, binaryPath: string | null) =>
  Effect.gen(function* () {
    const settings = yield* parse(text, "settings.json");
    const at = locate(settings, instanceId);
    if (at === null) return yield* new RouteError({ message: `T3 has no provider instance named ${instanceId}` });
    const holder = at.holder();
    if (binaryPath === null) delete holder["binaryPath"];
    else holder["binaryPath"] = binaryPath;
    return { text: prettyJson(settings), previous: at.current };
  });

export const routeProvider = (home: string, instanceId: string, launcher: string | null, options: { readonly undo?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = t3SettingsPath(home);
    const backup = `${file}.fleetx-models-backup`;
    const text = yield* fs.readFileString(file).pipe(Effect.mapError(() => new RouteError({ message: `${file} does not exist; has T3 run here?` })));
    let want = launcher;
    if (options.undo === true) {
      const saved = yield* fs.readFileString(backup).pipe(Effect.option);
      if (Option.isNone(saved)) return yield* new RouteError({ message: `no ${backup} to undo from` });
      const original = locate(yield* parse(saved.value, backup), instanceId);
      want = original?.current ?? null;
    }
    const edited = yield* withBinaryPath(text, instanceId, want);
    if (!(yield* fs.exists(backup))) {
      yield* fs.writeFileString(backup, text, { mode: 0o600 });
    }
    const tmp = `${file}.fleetx-tmp`;
    yield* fs.writeFileString(tmp, edited.text, { mode: 0o600 });
    yield* fs.rename(tmp, file);
    return { previous: edited.previous, now: want };
  });
