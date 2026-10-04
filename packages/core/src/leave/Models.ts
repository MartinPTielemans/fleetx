/**
 * Undoing the model routing: every place in T3's settings that names one of
 * T3 Fleet's launchers goes back to what it said before T3 Fleet routed it
 * (settings.json.t3-fleet-models-backup), or to T3's default. That is the
 * legacy `providers.<driver>.binaryPath`, which explicit instances inherit,
 * and each explicit instance's own `config.binaryPath`.
 *
 * While T3 runs, the change goes through T3 itself: `server.updateSettings`
 * over its WebSocket RPC, with a session from T3's own CLI (`t3 auth session
 * issue --ttl 2m`) that is revoked right after. When T3 is not running,
 * settings.json is edited instead, and only if nothing else changed it
 * meanwhile.
 *
 * A launcher is removed only once T3's settings, read back, no longer start
 * any provider through it.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { exec } from "../Exec.ts";
import { isLauncher } from "../Names.ts";
import { t3CliFromCommandLine, wsUrl } from "../T3Access.ts";
import { providerPlans, T3_DRIVERS, T3SettingsFile, t3SettingsPath } from "../T3Settings.ts";
import { editFile, isObject, prettyJson } from "./Files.ts";

type Json = Record<string, unknown>;
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const isLauncherPath = (p: unknown): p is string =>
  typeof p === "string" && isLauncher(basename(p));

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeUnknownOption(T3SettingsFile);

/** One binaryPath naming a launcher, and what it goes back to (null: T3's default). */
export interface Routed {
  readonly where: "legacy" | "instance";
  /** The driver (legacy) or the instance id. */
  readonly id: string;
  readonly launcher: string;
  readonly restore: string | null;
}

const legacyPath = (s: Json, driver: string) => {
  const providers = s["providers"];
  const entry = isObject(providers) ? providers[driver] : undefined;
  return isObject(entry) ? entry["binaryPath"] : undefined;
};
const instancePath = (s: Json, id: string) => {
  const instances = s["providerInstances"];
  const entry = isObject(instances) ? instances[id] : undefined;
  const config = isObject(entry) ? entry["config"] : undefined;
  return isObject(config) ? config["binaryPath"] : undefined;
};

/** Every binaryPath in `settings` that names a launcher. */
export const routedPaths = (settings: Json, backup: Json | null): Array<Routed> => {
  const out: Array<Routed> = [];
  const original = (value: unknown) =>
    typeof value === "string" && !isLauncherPath(value) ? value : null;
  const providers = isObject(settings["providers"]) ? settings["providers"] : {};
  for (const driver of Object.keys(providers)) {
    const value = legacyPath(settings, driver);
    if (isLauncherPath(value))
      out.push({
        where: "legacy",
        id: driver,
        launcher: value,
        restore: backup === null ? null : original(legacyPath(backup, driver)),
      });
  }
  const instances = isObject(settings["providerInstances"]) ? settings["providerInstances"] : {};
  for (const id of Object.keys(instances)) {
    const value = instancePath(settings, id);
    if (isLauncherPath(value))
      out.push({
        where: "instance",
        id,
        launcher: value,
        restore: backup === null ? null : original(instancePath(backup, id)),
      });
  }
  return out;
};

/** `settings` with each routed path put back; pure. */
export const unrouted = (settings: Json, routed: ReadonlyArray<Routed>): Json => {
  const next = structuredClone(settings);
  for (const r of routed) {
    const group = next[r.where === "legacy" ? "providers" : "providerInstances"];
    const entry = isObject(group) ? group[r.id] : undefined;
    const holder = r.where === "legacy" ? entry : isObject(entry) ? entry["config"] : undefined;
    // Only a path that still names the planned launcher: anything else is someone's newer choice.
    if (!isObject(holder) || holder["binaryPath"] !== r.launcher) continue;
    if (r.restore === null) delete holder["binaryPath"];
    else holder["binaryPath"] = r.restore;
  }
  return next;
};

/** The launchers T3 would still start some provider through, by file name. */
export const launchersInUse = (settings: Json) =>
  Option.match(decodeSettings(settings), {
    onNone: () => null,
    onSome: (decoded) =>
      new Set(
        providerPlans(decoded)
          .map((p) => p.binaryPath)
          .filter(isLauncherPath)
          .map(basename),
      ),
  });

// ---- T3 itself -----------------------------------------------------------------

const RuntimeFile = Schema.Struct({ pid: Schema.Number, origin: Schema.String });

export type RunningT3 =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "running";
      readonly origin: string;
      readonly cli: ReturnType<typeof t3CliFromCommandLine>;
    };

/** The T3 server running here, from T3's runtime file and its process. */
export const runningT3 = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(`${home}/.t3/userdata/server-runtime.json`)
      .pipe(Effect.option);
    if (Option.isNone(text)) return { _tag: "none" } as RunningT3;
    const runtime = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeFile))(text.value);
    if (Option.isNone(runtime)) return { _tag: "none" } as RunningT3;
    const ps = yield* exec({
      command: "ps",
      args: ["-ww", "-p", String(runtime.value.pid), "-o", "command="],
      timeout: Duration.seconds(5),
    });
    if (ps.code !== 0 || ps.stdout.trim() === "") return { _tag: "none" } as RunningT3;
    return {
      _tag: "running",
      origin: runtime.value.origin,
      cli: t3CliFromCommandLine(ps.stdout),
    } as RunningT3;
  });

class T3SettingsRpcs extends RpcGroup.make(
  Rpc.make("server.updateSettings", {
    payload: Schema.Struct({
      patch: Schema.Unknown,
      providerInstanceMutation: Schema.optionalKey(Schema.Unknown),
    }),
    success: Schema.Unknown,
    error: Schema.Struct({ _tag: Schema.String, message: Schema.optionalKey(Schema.String) }),
  }),
) {}

const Issued = Schema.Struct({ sessionId: Schema.String, token: Schema.String });
const Ticket = Schema.Struct({ ticket: Schema.String });

/** The payloads that put the routed paths back through server.updateSettings. */
export const settingsUpdates = (settings: Json, routed: ReadonlyArray<Routed>) => {
  const legacy: Record<string, { binaryPath: string }> = {};
  const instances: Array<{ id: string; instance: Json }> = [];
  for (const r of routed) {
    if (r.where === "legacy") {
      // Only a path that still names the planned launcher: anything else is a newer choice.
      if (legacyPath(settings, r.id) !== r.launcher) continue;
      // T3's patch cannot remove the field; its default command is what an absent one means.
      legacy[r.id] = { binaryPath: r.restore ?? T3_DRIVERS[r.id]?.bin ?? "" };
    } else {
      if (instancePath(settings, r.id) !== r.launcher) continue;
      // T3 takes an instance whole; it is the one T3 has now, with only binaryPath changed.
      const instance = structuredClone((settings["providerInstances"] as Json)[r.id] as Json);
      const config = { ...(instance["config"] as Json) };
      if (r.restore === null) delete config["binaryPath"];
      else config["binaryPath"] = r.restore;
      instances.push({ id: r.id, instance: { ...instance, config } });
    }
  }
  const updates: Array<{ patch: Json; providerInstanceMutation?: Json }> = [];
  const patch = Object.keys(legacy).length === 0 ? {} : { providers: legacy };
  if (instances.length === 0 && Object.keys(legacy).length > 0) updates.push({ patch });
  instances.forEach((m, i) =>
    updates.push({
      patch: i === 0 ? patch : {},
      providerInstanceMutation: { operation: "upsert", instanceId: m.id, instance: m.instance },
    }),
  );
  return updates;
};

/** Sends the updates to the running T3 with a two-minute session, revoked afterwards. */
export const throughT3 = (
  t3: Extract<RunningT3, { _tag: "running" }>,
  updates: ReadonlyArray<{ patch: Json; providerInstanceMutation?: Json }>,
) =>
  Effect.gen(function* () {
    const cli = t3.cli;
    if (cli === null)
      return yield* Effect.fail(
        "T3 is running, but its CLI could not be found from the server's command line; quit T3 and run leave again",
      );
    if (updates.length === 0) return;
    const run = (args: ReadonlyArray<string>) =>
      exec({
        command: cli.command,
        args: [...cli.args, ...args],
        env: { ...process.env, ...cli.env },
        timeout: Duration.seconds(60),
      });
    const issue = run([
      "auth",
      "session",
      "issue",
      "--ttl",
      "2m",
      "--label",
      "T3 Fleet leave",
      "--json",
    ]).pipe(
      Effect.flatMap((issued) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Issued))(issued.stdout.trim()).pipe(
          Effect.mapError(
            () =>
              `t3 auth session issue failed: ${(issued.stderr || issued.stdout).trim().split("\n").at(-1) ?? `exit ${issued.code}`}`,
          ),
        ),
      ),
    );
    const send = (session: typeof Issued.Type) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .execute(
            HttpClientRequest.post(
              new URL("/api/auth/websocket-ticket", t3.origin).toString(),
            ).pipe(HttpClientRequest.bearerToken(session.token)),
          )
          .pipe(
            Effect.timeout(Duration.seconds(5)),
            Effect.mapError(() => `T3 at ${t3.origin} did not answer`),
          );
        const ticket = yield* response.text.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Ticket))),
          Effect.mapError(() => `T3 refused a WebSocket ticket (HTTP ${response.status})`),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const rpc = yield* RpcClient.make(T3SettingsRpcs);
            for (const update of updates) yield* rpc["server.updateSettings"](update);
          }),
        ).pipe(
          Effect.provide(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(
                Socket.layerWebSocket(wsUrl(t3.origin, ticket.ticket), {
                  openTimeout: Duration.seconds(5),
                }),
              ),
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
              Layer.provide(RpcSerialization.layerJson),
            ),
          ),
          Effect.timeout(Duration.seconds(20)),
          Effect.mapError(
            (e) =>
              `server.updateSettings failed: ${String(isObject(e) && "message" in e ? e["message"] : e).slice(0, 200)}`,
          ),
        );
      });
    // The session is revoked however sending went; a revoke that fails is reported, never passed over.
    let revokeFailed: string | null = null;
    const revoke = (session: typeof Issued.Type) =>
      run(["auth", "session", "revoke", session.sessionId]).pipe(
        Effect.flatMap((r) =>
          Effect.sync(() => {
            if (r.code !== 0 || !r.stdout.includes("Revoked session"))
              revokeFailed = `revoking T3 session ${session.sessionId} failed (${(r.stderr || r.stdout).trim().split("\n").at(-1) ?? `exit ${r.code}`}); revoke it with: t3 auth session revoke ${session.sessionId}`;
          }),
        ),
      );
    const sent = yield* Effect.acquireUseRelease(issue, send, revoke).pipe(Effect.result);
    const failures = [
      ...(sent._tag === "Failure" ? [sent.failure] : []),
      ...(revokeFailed === null ? [] : [revokeFailed]),
    ];
    if (failures.length > 0) return yield* Effect.fail(failures.join("; "));
  });

// ---- the plan ----------------------------------------------------------------

export interface ModelsPlan {
  readonly routed: ReadonlyArray<Routed>;
  /** Launcher files in ~/.local/bin. */
  readonly launchers: ReadonlyArray<string>;
  /** Launchers the restored settings would still use: kept. */
  readonly stillUsed: ReadonlyArray<string>;
  readonly t3: RunningT3;
  /** settings.json is not valid JSON: nothing is changed in it. */
  readonly unreadable: boolean;
}

const readJson = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.option,
    Effect.map((text) =>
      Option.isNone(text)
        ? { _tag: "missing" as const }
        : Option.match(decodeJson(text.value), {
            onNone: () => ({ _tag: "invalid" as const }),
            onSome: (v) =>
              isObject(v) ? { _tag: "ok" as const, value: v } : { _tag: "invalid" as const },
          }),
    ),
  );

export const planModels = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = t3SettingsPath(home);
    const settings = yield* readJson(file);
    const backup = yield* readJson(`${file}.t3-fleet-models-backup`);
    const routed =
      settings._tag === "ok"
        ? routedPaths(settings.value, backup._tag === "ok" ? backup.value : null)
        : [];
    const launchers = (yield* fs
      .readDirectory(`${home}/.local/bin`)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>)))
      .filter(isLauncher)
      .sort();
    const after = settings._tag === "ok" ? launchersInUse(unrouted(settings.value, routed)) : null;
    const stillUsed =
      settings._tag === "invalid" ? launchers : launchers.filter((l) => after?.has(l) === true);
    const t3 = routed.length > 0 ? yield* runningT3(home) : ({ _tag: "none" } as RunningT3);
    return {
      routed,
      launchers,
      stillUsed,
      t3,
      unreadable: settings._tag === "invalid",
    } satisfies ModelsPlan;
  });

/** Puts the routed paths back, checks T3's settings no longer use any launcher, then removes them. */
export const applyModels = (home: string, plan: ModelsPlan) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = t3SettingsPath(home);
    const done: Array<string> = [];
    if (plan.routed.length > 0) {
      // Whether T3 runs is asked again: it may have started or stopped since the plan.
      const t3 = yield* runningT3(home);
      if (t3._tag === "running") {
        const current = yield* readJson(file);
        if (current._tag !== "ok") return yield* Effect.fail(`${file} is not readable JSON`);
        yield* throughT3(t3, settingsUpdates(current.value, plan.routed));
        done.push("T3's providers point where they did before (through T3's settings)");
      } else {
        yield* editFile(file, (text) =>
          Effect.gen(function* () {
            if (text === null) return null;
            const parsed = decodeJson(text);
            if (Option.isNone(parsed) || !isObject(parsed.value))
              return yield* Effect.fail(`${file} is not readable JSON`);
            return `${prettyJson(unrouted(parsed.value, plan.routed))}\n`;
          }),
        );
        done.push("T3's providers point where they did before (settings.json)");
      }
    }
    // Read back; T3 writes the file as it applies an update, give it a moment.
    let inUse: Set<string> | null = null;
    for (let i = 0; i < 10; i++) {
      const now = yield* readJson(file);
      inUse =
        now._tag === "missing" ? new Set() : now._tag === "ok" ? launchersInUse(now.value) : null;
      if (inUse !== null && inUse.size === 0) break;
      if (plan.routed.length === 0) break;
      yield* Effect.sleep(Duration.millis(500));
    }
    const keep = plan.launchers.filter((l) => inUse === null || inUse.has(l));
    for (const l of plan.launchers.filter((l) => !keep.includes(l)))
      yield* fs
        .remove(`${home}/.local/bin/${l}`)
        .pipe(Effect.mapError((e) => `removing ~/.local/bin/${l}: ${e.message}`));
    if (plan.launchers.length > keep.length)
      done.push(`removed ${plan.launchers.filter((l) => !keep.includes(l)).join(", ")}`);
    if (keep.length > 0)
      return yield* Effect.fail(
        `T3 still starts a provider through ${keep.join(", ")}, so ${keep.length === 1 ? "it stays" : "they stay"}; point the provider elsewhere in T3's settings and run leave again`,
      );
    return done;
  });
