/**
 * The part of T3's settings T3 Fleet reads: which provider instances T3 runs,
 * and with which binary. The probe uses it to launch each provider the way T3
 * would; the models area uses it to see whether T3 starts a provider through
 * its launcher. Everything else in settings.json is ignored.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderInstanceConfigMap } from "./vendor/t3/providerInstance.ts";

/**
 * T3's built-in providers: whether they are on when settings say nothing, and
 * the command they run (null for SDK-backed providers with no binary).
 * Mirrors the defaults in T3's contracts/settings.ts.
 */
export const T3_DRIVERS: Readonly<Record<string, { readonly enabled: boolean; readonly bin: string | null }>> = {
  codex: { enabled: true, bin: "codex" },
  claudeAgent: { enabled: true, bin: "claude" },
  grok: { enabled: false, bin: "grok" },
  pi: { enabled: false, bin: "pi" },
  opencode: { enabled: false, bin: "opencode" },
  cursor: { enabled: false, bin: null },
  antigravity: { enabled: false, bin: null },
};

const ProviderSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
});

export const T3SettingsFile = Schema.Struct({
  providers: Schema.optionalKey(Schema.Record(Schema.String, ProviderSettings)),
  providerInstances: Schema.optionalKey(ProviderInstanceConfigMap),
});
export type T3SettingsFile = typeof T3SettingsFile.Type;

const InstanceConfig = Schema.Struct({ binaryPath: Schema.optionalKey(Schema.String) });

export const t3SettingsPath = (home: string) => `${home}/.t3/userdata/settings.json`;

export interface ProviderPlan {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly binaryPath: string | null;
}

/** Instances T3 would run, with T3's own fallbacks applied. */
export const providerPlans = (settings: T3SettingsFile): Array<ProviderPlan> => {
  const legacy = settings.providers ?? {};
  const instances = settings.providerInstances ?? {};
  const plans: Array<ProviderPlan> = [];
  const decodeConfig = Schema.decodeUnknownOption(InstanceConfig);
  for (const [instanceId, instance] of Object.entries(instances)) {
    const driver = String(instance.driver);
    const defaults = T3_DRIVERS[driver];
    const config = Option.getOrElse(decodeConfig(instance.config ?? {}), () => ({}) as typeof InstanceConfig.Type);
    plans.push({
      instanceId,
      driver,
      enabled: instance.enabled ?? legacy[driver]?.enabled ?? defaults?.enabled ?? false,
      binaryPath: config.binaryPath || legacy[driver]?.binaryPath || defaults?.bin || null,
    });
  }
  for (const [driver, defaults] of Object.entries(T3_DRIVERS)) {
    if (plans.some((p) => p.driver === driver)) continue;
    plans.push({
      instanceId: driver,
      driver,
      enabled: legacy[driver]?.enabled ?? defaults.enabled,
      binaryPath: legacy[driver]?.binaryPath || defaults.bin,
    });
  }
  return plans.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
};

/** T3's settings on this machine: none when T3 never ran here; "invalid" when unreadable. */
export const readT3Settings = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(t3SettingsPath(home)).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<T3SettingsFile | "invalid">();
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(T3SettingsFile))(text.value).pipe(Effect.option);
    return Option.some<T3SettingsFile | "invalid">(Option.getOrElse(decoded, () => "invalid" as const));
  });
