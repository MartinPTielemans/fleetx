/**
 * Observes the machine it runs on. Read-only: it starts processes only to ask
 * them for `--version` (and, as a fallback, for login status), and never
 * writes a file. Provider logins come from T3 itself (T3Access.ts).
 *
 * The provider check is the point of T3 Fleet. T3 launches providers with its
 * server's environment, not your shell's, and the two differ: a server
 * ran without ~/.local/bin on PATH, so a Codex that worked in every terminal
 * failed in T3. The probe therefore reads the running server's environment and
 * launches each provider exactly the way T3 would.
 */
import * as Cause from "effect/Cause";
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

import type { ProviderAuth } from "./Api.ts";
import { expandHome, type ProbeSettings } from "./Config.ts";
import { exec, parseVersion } from "./Exec.ts";
import { cliLogin } from "./CliLogin.ts";
import type { AnyArea } from "./Area.ts";
import { loadAreas, why, type PluginProblem } from "./Plugins.ts";
import {
  PROBE_PROTOCOL,
  type AgentObservation,
  type SyncObservation,
  type MachineObservation,
  type ProviderObservation,
  type ProxyObservation,
  type T3Observation,
} from "./Observation.ts";
import {
  readAccess,
  readProviderSnapshot,
  RENEW_WITHIN_MS,
  t3AccessAttemptPath,
  t3CliFromCommandLine,
} from "./T3Access.ts";
import { providerPlans, T3SettingsFile, type ProviderPlan } from "./T3Settings.ts";
import { ExecutionEnvironmentDescriptor } from "./vendor/t3/environment.ts";
import { stateDir } from "./Names.ts";

/** Moved to T3Settings.ts; re-exported for existing importers. */
export { providerPlans, T3_DRIVERS } from "./T3Settings.ts";

type Env = Readonly<Record<string, string | undefined>>;

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
      ? (parseVersion(
          (yield* exec({
            command: managedPath,
            args: ["--version"],
            timeout: Duration.seconds(20),
          })).stdout,
        ) ?? null)
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

const decodeJson = <S extends Schema.Top>(schema: S, text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.option);

export const isAlive = (pid: number) =>
  exec({
    command: "ps",
    args: ["-p", String(pid), "-o", "pid="],
    timeout: Duration.seconds(5),
  }).pipe(Effect.map((r) => r.code === 0 && r.stdout.trim() !== ""));

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
    const ps = yield* exec({
      command: "ps",
      args: ["-wwE", "-p", String(pid), "-o", "command="],
      timeout: Duration.seconds(5),
    });
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
export const runtimeFromCommandLine = (pid: number) =>
  Effect.gen(function* () {
    const ps = yield* exec({
      command: "ps",
      args: ["-ww", "-p", String(pid), "-o", "command="],
      timeout: Duration.seconds(5),
    });
    const match = /(\S*\/versions\/([0-9][^/\s]*)\/t3)\b/.exec(ps.stdout);
    return {
      binary: match?.[1] ?? null,
      version: match?.[2] ?? null,
      cli: t3CliFromCommandLine(ps.stdout) !== null,
    };
  });

export const fetchDescriptor = (origin: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const text = yield* client
      .execute(HttpClientRequest.get(`${origin}/.well-known/t3/environment`))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((r) => r.text),
        Effect.timeout(Duration.seconds(4)),
        Effect.option,
      );
    if (Option.isNone(text)) return Option.none<ExecutionEnvironmentDescriptor>();
    return yield* decodeJson(ExecutionEnvironmentDescriptor, text.value);
  });

const observeProvider = (plan: ProviderPlan, env: Env) =>
  Effect.gen(function* () {
    const base = {
      instanceId: plan.instanceId,
      driver: plan.driver,
      enabled: plan.enabled,
      binaryPath: plan.binaryPath,
    };
    if (!plan.enabled || plan.binaryPath === null) {
      return {
        ...base,
        resolved: null,
        launch: {
          ok: true,
          version: null,
          detail: plan.enabled ? "no binary (SDK provider)" : "disabled",
        },
      };
    }
    const resolved = (yield* resolveAll(plan.binaryPath, env["PATH"]))[0] ?? null;
    if (resolved === null) {
      return {
        ...base,
        resolved,
        launch: {
          ok: false,
          version: null,
          detail: `${plan.binaryPath} is not on the T3 server's PATH`,
        },
      };
    }
    const run = yield* exec({
      command: resolved,
      args: ["--version"],
      env,
      timeout: Duration.seconds(20),
    });
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
    const problems: Array<{ kind: string; title: string }> = [];
    const problem = (kind: string, title: string) => problems.push({ kind, title });
    const runtimeText = yield* readText(`${home}/.t3/userdata/server-runtime.json`);
    const runtimeFile = Option.isSome(runtimeText)
      ? yield* decodeJson(RuntimeFile, runtimeText.value)
      : Option.none();

    let runtime: T3Observation["runtime"] = null;
    let descriptor: T3Observation["descriptor"] = null;
    let installedVersion: string | null = null;
    let runtimeBinary: string | null = null;
    let serverEnv: Env | null = null;
    let cli = false;

    if (Option.isSome(runtimeFile)) {
      const r = runtimeFile.value;
      const alive = yield* isAlive(r.pid);
      runtime = {
        pid: r.pid,
        origin: r.origin,
        serviceManaged: r.serviceManaged ?? false,
        alive,
        startedAt: r.startedAt ?? null,
      };
      if (alive) {
        const d = yield* fetchDescriptor(r.origin);
        if (Option.isSome(d)) {
          descriptor = {
            environmentId: String(d.value.environmentId),
            label: d.value.label,
            serverVersion: d.value.serverVersion,
            protocol: d.value.orchestrationProtocolVersion ?? 1,
          };
        } else {
          problem(
            "no-descriptor",
            `server at ${r.origin} did not answer /.well-known/t3/environment`,
          );
        }
        const fromCommandLine = yield* runtimeFromCommandLine(r.pid);
        runtimeBinary = fromCommandLine.binary;
        cli = fromCommandLine.cli;
        installedVersion = descriptor?.serverVersion ?? fromCommandLine.version;
        serverEnv = Option.getOrNull(yield* serverEnvironment(r.pid));
        if (serverEnv === null)
          problem(
            "env-unreadable",
            "could not read the T3 server's environment; providers checked with the login PATH",
          );
      } else {
        problem("not-running", `T3 server (pid ${r.pid}) is not running`);
      }
    } else if (Option.isSome(runtimeText)) {
      problem("runtime-unreadable", "server-runtime.json is unreadable");
    }

    const settingsText = yield* readText(`${home}/.t3/userdata/settings.json`);
    // T3 has run here but no server is up now (stopped, or mid-restart).
    if (Option.isNone(runtimeText) && Option.isSome(settingsText)) {
      problem("not-running", "the T3 server is not running");
    }
    let providers: Array<ProviderObservation> = [];
    if (Option.isSome(settingsText)) {
      const settings = yield* decodeJson(T3SettingsFile, settingsText.value);
      if (Option.isNone(settings)) {
        problem(
          "settings-unrecognized",
          "settings.json did not match the provider settings T3 Fleet understands",
        );
      } else {
        providers = yield* Effect.forEach(
          providerPlans(settings.value),
          (p) => observeProvider(p, serverEnv ?? loginEnv),
          { concurrency: 4 },
        );
      }
    }

    // Logins: T3's own snapshot when T3 Fleet can read it, else each CLI's status command.
    let access: T3Observation["access"] = null;
    let providerAuth: Array<ProviderAuth> = [];
    if (runtime?.alive === true) {
      const now = yield* Clock.currentTimeMillis;
      const token = yield* readAccess(home);
      const attempted = Number(
        Option.getOrElse(yield* readText(t3AccessAttemptPath(home)), () => "").trim(),
      );
      const attempt = attempted > 0 ? { lastAttempt: attempted } : {};
      if (Option.isNone(token) || token.value.origin !== runtime.origin) {
        access = {
          state: "none",
          expiresAt: null,
          detail: Option.isNone(token)
            ? "T3 Fleet has no T3 token here"
            : `T3 Fleet's token is for ${token.value.origin}`,
          cli,
          ...attempt,
        };
      } else if (token.value.expiresAt <= now) {
        access = {
          state: "rejected",
          expiresAt: token.value.expiresAt,
          detail: "T3 Fleet's T3 token has expired",
          cli,
          ...attempt,
        };
      } else {
        const snapshot = yield* readProviderSnapshot(runtime.origin, token.value.token);
        const expiring = token.value.expiresAt - now < RENEW_WITHIN_MS;
        if (snapshot._tag === "ok") {
          providerAuth = [...snapshot.providers];
          access = {
            state: expiring ? "expiring" : "ok",
            expiresAt: token.value.expiresAt,
            detail: "read from T3",
            cli,
            ...attempt,
          };
        } else {
          access = {
            state: snapshot._tag === "rejected" ? "rejected" : "failed",
            expiresAt: token.value.expiresAt,
            detail: snapshot._tag === "rejected" ? "T3 refused T3 Fleet's token" : snapshot.detail,
            cli,
            ...attempt,
          };
        }
      }
    }
    if (providerAuth.length === 0) {
      const env = serverEnv ?? loginEnv;
      const checks = providers.flatMap((p) => {
        const check = cliLogin(p.driver);
        return p.enabled && p.launch.ok && p.resolved !== null && check !== null
          ? [{ p, run: check(p.resolved, env) }]
          : [];
      });
      providerAuth = yield* Effect.forEach(
        checks,
        ({ p, run }) =>
          Effect.map(run, (login): ProviderAuth => ({
            instanceId: p.instanceId,
            driver: p.driver,
            enabled: p.enabled,
            ...login,
            label: null,
            status: null,
            checkedAt: null,
            source: "cli",
          })),
        { concurrency: 4 },
      );
    }

    const t3 = {
      runtime,
      descriptor,
      installedVersion,
      runtimeBinary,
      serverPath: serverEnv?.["PATH"] ?? null,
      providers,
      access,
      problems,
    } satisfies T3Observation;
    return { t3, providerAuth };
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
    const creds = Option.isSome(text)
      ? yield* decodeJson(ProxyCredentials, text.value)
      : Option.none();
    if (Option.isNone(creds))
      return { launchers, credentials: false, key: null } satisfies ProxyObservation;
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
      onSome: (code) =>
        code >= 200 && code < 300
          ? "accepted"
          : code === 401 || code === 403
            ? "rejected"
            : `HTTP ${code}`,
    });
    return { launchers, credentials: true, key } satisfies ProxyObservation;
  });

// ---- the last sync ---------------------------------------------------------

/** Where `t3-fleet sync` records each run on the node: `<seconds>\t<ok|fail>\t<streak>\t<message>`. */
export const lastSyncPath = (home: string) => `${stateDir(home)}/last-sync`;

/** T3 Fleet's own record of the last sync here; null where it has never synced. */
const observeLastSync = (home: string) =>
  Effect.gen(function* () {
    const own = yield* readText(lastSyncPath(home));
    if (Option.isNone(own)) return null;
    const [when, result, streak, ...message] = own.value.trim().split("\t");
    return {
      when: Number(when) || 0,
      result: result ?? "unknown",
      message: message.join("\t"),
      streak: Number(streak) || 0,
    } satisfies SyncObservation;
  });

// ---- areas ------------------------------------------------------------------

/**
 * Every area's facts, keyed by its id; plugins that did not load under
 * "_plugins". Each area runs on its own: one that fails or throws, a plugin's
 * most of all, is recorded as unreadable and the others still observe.
 */
export const observeAreas = (
  loaded: {
    readonly areas: ReadonlyArray<AnyArea>;
    readonly problems: ReadonlyArray<PluginProblem>;
  },
  settings: ProbeSettings,
  base: { readonly home: string; readonly checkout: string; readonly env: Env },
) =>
  Effect.gen(function* () {
    const areas: Record<string, unknown> = {};
    if (loaded.problems.length > 0) areas["_plugins"] = { problems: loaded.problems };
    yield* Effect.forEach(
      loaded.areas,
      (area) =>
        Effect.gen(function* () {
          const desired = yield* Schema.decodeUnknownEffect(area.desired)(
            settings.areas?.[area.id],
          ).pipe(Effect.option);
          if (Option.isNone(desired)) {
            areas[area.id] = { invalidSettings: true };
            return;
          }
          const observed = yield* Effect.suspend(() =>
            area.observe(desired.value, {
              ...base,
              engine: settings.engine ?? null,
              engineBuild: settings.build ?? null,
              node: settings.node ?? null,
              roles: settings.roles ?? [],
              relay: settings.relay ?? null,
            }),
          ).pipe(Effect.mapError((e) => `could not observe it: ${why(e)}`));
          areas[area.id] = yield* Schema.encodeUnknownEffect(area.observed)(observed).pipe(
            Effect.mapError((e) => `what it observed does not match its schema: ${why(e)}`),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              areas[area.id] = { unreadable: why(Cause.squash(cause)) };
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return areas;
  });

// ---- machine --------------------------------------------------------------

export const probeMachine = (settings: ProbeSettings = {}) =>
  Effect.gen(function* () {
    const env: Env = process.env;
    const home = env["HOME"] ?? "";
    const hostname = (yield* exec({
      command: "hostname",
      timeout: Duration.seconds(5),
    })).stdout.trim();
    const [agents, { t3, providerAuth }, proxy, lastSync] = yield* Effect.all(
      [
        Effect.forEach(["claude", "codex"] as const, (a) => observeAgent(a, home, env["PATH"]), {
          concurrency: 2,
        }),
        observeT3(home, env),
        observeProxy(home, settings.proxy),
        observeLastSync(home),
      ],
      { concurrency: "unbounded" },
    );
    const checkout = expandHome(settings.checkout ?? "~/fleet", home);
    const areas = yield* observeAreas(
      yield* loadAreas(checkout, settings.plugins ?? []),
      settings,
      { home, checkout, env },
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
      providerAuth,
      proxy,
      areas,
      lastSync,
    } satisfies MachineObservation;
  });
