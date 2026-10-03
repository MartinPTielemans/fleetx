/**
 * Observes the machine it runs on. Read-only: it starts processes only to ask
 * them for `--version`, and never writes a file.
 *
 * The provider check is the point of fleetx. T3 launches providers with its
 * server's environment, not your shell's, and the two differ: a server
 * ran without ~/.local/bin on PATH, so a Codex that worked in every terminal
 * failed in T3. The probe therefore reads the running server's environment and
 * launches each provider exactly the way T3 would.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { expandHome, type ProbeSettings } from "./Config.ts";
import { exec, parseVersion } from "./Exec.ts";
import { loadAreas } from "./Plugins.ts";
import {
  PROBE_PROTOCOL,
  type AgentObservation,
  type LegacySyncObservation,
  type MachineObservation,
  type ProviderObservation,
  type ProxyObservation,
  type T3Observation,
} from "./Observation.ts";
import { ExecutionEnvironmentDescriptor } from "./vendor/t3/environment.ts";
import { ProviderInstanceConfigMap } from "./vendor/t3/providerInstance.ts";

type Env = Readonly<Record<string, string | undefined>>;

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

// ---- filesystem helpers -------------------------------------------------

const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(Effect.option);
  });

const isExecutableFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(file).pipe(Effect.option);
    return Option.match(info, {
      onNone: () => false,
      onSome: (s) => s.type === "File" && (Number(s.mode) & 0o111) !== 0,
    });
  });

/** Every executable named `name` on `pathVar`, in resolution order. */
export const resolveAll = (name: string, pathVar: string | undefined) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (name.includes("/")) return (yield* isExecutableFile(name)) ? [name] : [];
    const fs = yield* FileSystem.FileSystem;
    const hits: Array<string> = [];
    const seen = new Set<string>();
    for (const dir of (pathVar ?? "").split(":")) {
      if (dir === "") continue;
      const candidate = path.join(dir, name);
      if (!(yield* isExecutableFile(candidate))) continue;
      // /bin/x and /usr/bin/x are one file where /bin links to /usr/bin.
      const real = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate));
      if (seen.has(real)) continue;
      seen.add(real);
      hits.push(candidate);
    }
    return hits;
  });

// ---- agents -------------------------------------------------------------

const observeAgent = (name: "claude" | "codex", home: string, loginPath: string | undefined) =>
  Effect.gen(function* () {
    const managedPath = `${home}/.local/bin/${name}`;
    const managed = yield* isExecutableFile(managedPath);
    const version = managed
      ? parseVersion((yield* exec({ command: managedPath, args: ["--version"], timeout: Duration.seconds(20) })).stdout) ?? null
      : null;
    return {
      name,
      managedPath,
      managedVersion: version,
      onPath: yield* resolveAll(name, loginPath),
    } satisfies AgentObservation;
  });

// ---- T3 -----------------------------------------------------------------

const RuntimeFile = Schema.Struct({
  pid: Schema.Number,
  origin: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  startedAt: Schema.optional(Schema.String),
});

const ProviderSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
});

/** The part of T3's settings.json fleetx reads; everything else is ignored. */
const SettingsFile = Schema.Struct({
  providers: Schema.optionalKey(Schema.Record(Schema.String, ProviderSettings)),
  providerInstances: Schema.optionalKey(ProviderInstanceConfigMap),
});

const InstanceConfig = Schema.Struct({ binaryPath: Schema.optionalKey(Schema.String) });

const decodeJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.option);

const isAlive = (pid: number) =>
  exec({ command: "ps", args: ["-p", String(pid), "-o", "pid="], timeout: Duration.seconds(5) }).pipe(
    Effect.map((r) => r.code === 0 && r.stdout.trim() !== ""),
  );

/**
 * The running server's environment. Linux exposes it in /proc; macOS prints
 * it after the command with `ps -E`, which is space-separated, so values with
 * spaces are truncated. PATH and HOME never contain spaces in practice.
 */
const serverEnvironment = (pid: number) =>
  Effect.gen(function* () {
    if (process.platform === "linux") {
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs.readFile(`/proc/${pid}/environ`).pipe(Effect.option);
      if (Option.isNone(raw)) return Option.none<Env>();
      const env: Record<string, string> = {};
      for (const entry of new TextDecoder().decode(raw.value).split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      return Option.some<Env>(env);
    }
    const ps = yield* exec({ command: "ps", args: ["-wwE", "-p", String(pid), "-o", "command="], timeout: Duration.seconds(5) });
    if (ps.code !== 0) return Option.none<Env>();
    const env: Record<string, string> = {};
    for (const m of ps.stdout.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g)) {
      if (m[1] !== undefined && m[2] !== undefined && env[m[1]] === undefined) env[m[1]] = m[2];
    }
    return env["PATH"] === undefined ? Option.none<Env>() : Option.some<Env>(env);
  });

/**
 * A service-managed server runs from ~/.t3/runtime/versions/<version>/t3; the
 * desktop app runs its own copy and has neither.
 */
const runtimeFromCommandLine = (pid: number) =>
  Effect.gen(function* () {
    const ps = yield* exec({ command: "ps", args: ["-ww", "-p", String(pid), "-o", "command="], timeout: Duration.seconds(5) });
    const match = /(\S*\/versions\/([0-9][^/\s]*)\/t3)\b/.exec(ps.stdout);
    return { binary: match?.[1] ?? null, version: match?.[2] ?? null };
  });

const fetchDescriptor = (origin: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const text = yield* client.execute(HttpClientRequest.get(`${origin}/.well-known/t3/environment`)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((r) => r.text),
      Effect.timeout(Duration.seconds(4)),
      Effect.option,
    );
    if (Option.isNone(text)) return Option.none<ExecutionEnvironmentDescriptor>();
    return yield* decodeJson(ExecutionEnvironmentDescriptor, text.value);
  });

interface ProviderPlan {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly binaryPath: string | null;
}

/** Instances T3 would run, with T3's own fallbacks applied. */
export const providerPlans = (settings: typeof SettingsFile.Type): Array<ProviderPlan> => {
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

const observeProvider = (plan: ProviderPlan, env: Env) =>
  Effect.gen(function* () {
    const base = { instanceId: plan.instanceId, driver: plan.driver, enabled: plan.enabled, binaryPath: plan.binaryPath };
    if (!plan.enabled || plan.binaryPath === null) {
      return { ...base, resolved: null, launch: { ok: true, version: null, detail: plan.enabled ? "no binary (SDK provider)" : "disabled" } };
    }
    const resolved = (yield* resolveAll(plan.binaryPath, env["PATH"]))[0] ?? null;
    if (resolved === null) {
      return {
        ...base,
        resolved,
        launch: { ok: false, version: null, detail: `${plan.binaryPath} is not on the T3 server's PATH` },
      };
    }
    const run = yield* exec({ command: resolved, args: ["--version"], env, timeout: Duration.seconds(20) });
    const output = `${run.stdout}\n${run.stderr}`.trim();
    const version = parseVersion(run.stdout) ?? null;
    const ok = run.code === 0 && version !== null;
    const detail = run.timedOut
      ? "timed out after 20s"
      : run.spawnError !== undefined
        ? run.spawnError
        : ok
          ? "starts"
          : (output.split("\n").find((l) => l.trim() !== "") ?? `exit ${run.code}`).slice(0, 240);
    return { ...base, resolved, launch: { ok, version, detail } };
  });

const observeT3 = (home: string, loginEnv: Env) =>
  Effect.gen(function* () {
    const problems: Array<string> = [];
    const runtimeText = yield* readText(`${home}/.t3/userdata/server-runtime.json`);
    const runtimeFile = Option.isSome(runtimeText) ? yield* decodeJson(RuntimeFile, runtimeText.value) : Option.none();

    let runtime: T3Observation["runtime"] = null;
    let descriptor: T3Observation["descriptor"] = null;
    let installedVersion: string | null = null;
    let runtimeBinary: string | null = null;
    let serverEnv: Env | null = null;

    if (Option.isSome(runtimeFile)) {
      const r = runtimeFile.value;
      const alive = yield* isAlive(r.pid);
      runtime = { pid: r.pid, origin: r.origin, serviceManaged: r.serviceManaged ?? false, alive, startedAt: r.startedAt ?? null };
      if (alive) {
        const d = yield* fetchDescriptor(r.origin);
        if (Option.isSome(d)) {
          descriptor = { environmentId: String(d.value.environmentId), label: d.value.label, serverVersion: d.value.serverVersion };
        } else {
          problems.push(`server at ${r.origin} did not answer /.well-known/t3/environment`);
        }
        const fromCommandLine = yield* runtimeFromCommandLine(r.pid);
        runtimeBinary = fromCommandLine.binary;
        installedVersion = descriptor?.serverVersion ?? fromCommandLine.version;
        serverEnv = Option.getOrNull(yield* serverEnvironment(r.pid));
        if (serverEnv === null) problems.push("could not read the T3 server's environment; providers checked with the login PATH");
      } else {
        problems.push(`T3 server (pid ${r.pid}) is not running`);
      }
    } else if (Option.isSome(runtimeText)) {
      problems.push("server-runtime.json is unreadable");
    }

    const settingsText = yield* readText(`${home}/.t3/userdata/settings.json`);
    // T3 has run here but no server is up now (stopped, or mid-restart).
    if (Option.isNone(runtimeText) && Option.isSome(settingsText)) {
      problems.push("the T3 server is not running");
    }
    let providers: Array<ProviderObservation> = [];
    if (Option.isSome(settingsText)) {
      const settings = yield* decodeJson(SettingsFile, settingsText.value);
      if (Option.isNone(settings)) {
        problems.push("settings.json did not match the provider settings fleetx understands");
      } else {
        const env = serverEnv ?? loginEnv;
        providers = yield* Effect.forEach(providerPlans(settings.value), (p) => observeProvider(p, env), { concurrency: 4 });
      }
    }

    return {
      runtime,
      descriptor,
      installedVersion,
      runtimeBinary,
      serverPath: serverEnv?.["PATH"] ?? null,
      providers,
      problems,
    } satisfies T3Observation;
  });

// ---- fleet model proxy -----------------------------------------------------

const ProxyCredentials = Schema.Struct({ endpoint: Schema.String, api_key: Schema.String });

const observeProxy = (home: string, settings: ProbeSettings["proxy"]) =>
  Effect.gen(function* () {
    if (settings === undefined) return null;
    const launchers: Record<string, string | null> = {};
    for (const [instanceId, configured] of Object.entries(settings.launchers)) {
      const path = expandHome(configured, home);
      launchers[instanceId] = (yield* isExecutableFile(path)) ? path : null;
    }
    const text = yield* readText(expandHome(settings.credentials, home));
    const creds = Option.isSome(text) ? yield* decodeJson(ProxyCredentials, text.value) : Option.none();
    if (Option.isNone(creds)) return { launchers, credentials: false, key: null } satisfies ProxyObservation;
    const client = yield* HttpClient.HttpClient;
    const status = yield* client
      .execute(
        HttpClientRequest.get(`${creds.value.endpoint.replace(/\/+$/, "")}/models`).pipe(
          HttpClientRequest.bearerToken(creds.value.api_key),
        ),
      )
      .pipe(
        Effect.map((r) => r.status),
        Effect.timeout(Duration.seconds(10)),
        Effect.option,
      );
    const key = Option.match(status, {
      onNone: () => "proxy unreachable",
      onSome: (code) => (code >= 200 && code < 300 ? "accepted" : code === 401 || code === 403 ? "rejected" : `HTTP ${code}`),
    });
    return { launchers, credentials: true, key } satisfies ProxyObservation;
  });

// ---- a bash `fleet sync` timer, where one runs alongside -------------------

const observeLegacySync = (home: string) =>
  Effect.gen(function* () {
    const last = yield* readText(`${home}/.local/state/fleet/last-sync`);
    if (Option.isNone(last)) return null;
    const [when, result, ...message] = last.value.trim().split("\t");
    const streak = Option.getOrElse(yield* readText(`${home}/.local/state/fleet/sync-streak`), () => "0");
    return {
      when: Number(when) || 0,
      result: result ?? "unknown",
      message: message.join("\t"),
      streak: Number(streak.trim()) || 0,
    } satisfies LegacySyncObservation;
  });

// ---- machine --------------------------------------------------------------

export const probeMachine = (settings: ProbeSettings = {}) => Effect.gen(function* () {
  const env: Env = process.env;
  const home = env["HOME"] ?? "";
  const hostname = (yield* exec({ command: "hostname", timeout: Duration.seconds(5) })).stdout.trim();
  const [agents, t3, proxy, legacySync] = yield* Effect.all(
    [
      Effect.forEach(["claude", "codex"] as const, (a) => observeAgent(a, home, env["PATH"]), { concurrency: 2 }),
      observeT3(home, env),
      observeProxy(home, settings.proxy),
      observeLegacySync(home),
    ],
    { concurrency: "unbounded" },
  );
  const checkout = expandHome(settings.checkout ?? "~/fleet", home);
  const areas: Record<string, unknown> = {};
  const loaded = yield* loadAreas(checkout, settings.plugins ?? []);
  if (loaded.problems.length > 0) areas["_plugins"] = { problems: loaded.problems };
  yield* Effect.forEach(
    loaded.areas,
    (area) =>
      Effect.gen(function* () {
        const desired = yield* Schema.decodeUnknownEffect(area.desired)(settings.areas?.[area.id]).pipe(Effect.option);
        if (Option.isNone(desired)) {
          areas[area.id] = { invalidSettings: true };
          return;
        }
        const observed = yield* area.observe(desired.value, {
          home,
          checkout,
          env,
          engine: settings.engine ?? null,
          node: settings.node ?? null,
          roles: settings.roles ?? [],
          relay: settings.relay ?? null,
        });
        areas[area.id] = yield* Schema.encodeUnknownEffect(area.observed)(observed).pipe(Effect.orElseSucceed(() => null));
      }),
    { concurrency: "unbounded" },
  );
  return {
    protocol: PROBE_PROTOCOL,
    hostname,
    platform: process.platform,
    arch: process.arch,
    user: env["USER"] ?? env["LOGNAME"] ?? "",
    observedAt: yield* Clock.currentTimeMillis,
    agents,
    t3,
    proxy,
    areas,
    legacySync,
  } satisfies MachineObservation;
});
