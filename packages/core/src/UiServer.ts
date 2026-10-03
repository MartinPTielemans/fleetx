/**
 * The server behind `fleetx ui`: the built app and its /api, on 127.0.0.1.
 *
 *   GET  /api/session, /api/status, /api/proposals, /api/alerts,
 *        /api/models, /api/config/<node>, /api/hub/servers, /api/hub/calls
 *   POST /api/fixes, /api/proposals/<node>/approve | /reject,
 *        /api/hub/servers/<name>/login | /logout | /restart
 *   GET  /api/events     server-sent events: the relay's, plus "check"
 *   GET  *               the app
 *
 * Shapes are the ones in Api.ts, encoded here and decoded by the app.
 *
 * Other websites in the same browser must not be able to read the fleet or
 * drive fixes. Every /api request needs this run's token (the browser gets it
 * in the URL fragment `fleetx ui` opens, and sends it as a header; a page on
 * another origin cannot read it or set that header without a CORS preflight,
 * which is never granted). The Host header must name this loopback port, so a
 * DNS-rebinding page cannot pose as the same origin, and an Origin, when sent,
 * must be this one. The app may not be framed, so it cannot be clickjacked.
 *
 * A check runs at start, then every minute while a browser is connected.
 * Applying fixes follows fleet_apply_fixes: it checks again first and runs
 * only fixes that check still proposes.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  HubCall,
  HubLoginStart,
  HubServer,
  ModelProxyStats,
  UiAlert,
  UiApplyRequest,
  UiApplyResult,
  UiConfigRow,
  UiModels,
  UiProposal,
  UiSession,
  UiStatus,
  type UiEnvironment,
  type UiFinding,
} from "./Api.ts";
import type { CheckReport } from "./Check.ts";
import { providerLabel, type Finding, type Fix } from "./Diagnose.ts";
import type { FixOutcome } from "./Fix.ts";
import { releasesBehind } from "./Latest.ts";
import { findingId } from "./Memory.ts";
import type { MachineObservation } from "./Observation.ts";
import { renderStatus } from "./Render.ts";
import type { NodeState } from "./State.ts";
import { cliReleaseChannelOf } from "./vendor/t3/cliRelease.ts";

/** A full check, with what it needs to be shown: published sync states and accepted differences. */
export interface UiCheck {
  readonly report: CheckReport;
  readonly states: ReadonlyArray<NodeState>;
  readonly accepted: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/** What the server does on the fleet; `fleetx ui` wires these to the real engine, tests to fakes. */
export interface UiActions {
  readonly check: Effect.Effect<UiCheck, string>;
  readonly apply: (fixes: ReadonlyArray<Finding & { readonly fix: Fix }>) => Effect.Effect<ReadonlyArray<FixOutcome>>;
  readonly proposals: Effect.Effect<ReadonlyArray<UiProposal>, string>;
  readonly approve: (node: string) => Effect.Effect<void, string>;
  readonly reject: (node: string) => Effect.Effect<void, string>;
  readonly alerts: Effect.Effect<ReadonlyArray<typeof UiAlert.Type>, string>;
  readonly config: (node: string) => Effect.Effect<ReadonlyArray<UiConfigRow>, string>;
}
type UiConfigRow = typeof UiConfigRow.Type;

export interface UiAsset {
  readonly type: string;
  readonly body: Uint8Array;
}

export interface UiServerOptions {
  /** This run's token; every /api request must carry it. */
  readonly token: string;
  /** The port the server listens on, for the Host check. */
  readonly port: number;
  /** The built app, by URL path ("/index.html", "/assets/…"). */
  readonly assets: ReadonlyMap<string, UiAsset>;
  readonly session: UiSession;
  readonly actions: UiActions;
  /** The relay and its token, when the fleet has one. */
  readonly relay: { readonly url: string; readonly token: string } | null;
  readonly checkEvery?: Duration.Input;
}

// ── turning a check into what the UI shows ──────────────────────────────

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The models area's launchers are ~/.local/bin/fleetx-<provider> (docs/design/companion.md). */
const viaModelsLauncher = (binaryPath: string | null) => binaryPath !== null && basename(binaryPath).startsWith("fleetx-");

/**
 * The model proxy's stats, as the models area reports them in an observation:
 * read loosely, as top-level `models` or the area's `stats`, so a node on an
 * older fleetx is "not reported" rather than an error.
 */
const observed = <S extends Schema.Top & { readonly DecodingServices: never }>(obs: MachineObservation, key: string, schema: S): S["Type"] | null => {
  const top = (obs as unknown as Readonly<Record<string, unknown>>)[key];
  const area = obs.areas["models"];
  const nested = typeof area === "object" && area !== null ? (area as Readonly<Record<string, unknown>>)[key] : undefined;
  for (const candidate of [top, nested]) {
    if (candidate === undefined || candidate === null) continue;
    const decoded = Schema.decodeUnknownOption(schema)(candidate);
    if (Option.isSome(decoded)) return decoded.value;
  }
  return null;
};

export const observedModels = (obs: MachineObservation) =>
  observed(obs, "models", ModelProxyStats) ?? observed(obs, "stats", ModelProxyStats);

const toFinding = (f: Finding, accepted: ReadonlyMap<string, string>): UiFinding => {
  const id = findingId(f);
  const reason = accepted.get(id);
  const detail = reason !== undefined && f.detail === `accepted: ${reason}` ? undefined : f.detail;
  return {
    id,
    node: f.node,
    severity: f.severity,
    area: f.area,
    title: f.title,
    ...(detail === undefined ? {} : { detail }),
    ...(f.fix === undefined
      ? {}
      : {
          fix: {
            command: f.fix.command,
            safe: f.fix.safe,
            ...(f.fix.disrupts === undefined ? {} : { disrupts: f.fix.disrupts }),
            ...(f.fix.on === undefined ? {} : { on: f.fix.on }),
          },
        }),
    ...(reason === undefined ? {} : { accepted: reason }),
  };
};

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

export const toUiStatus = (check: UiCheck, checkedAt: number): UiStatus => {
  const { report, states } = check;
  const accepted = new Map(check.accepted.map((a) => [a.id, a.reason]));
  const environments = report.results.map((r): UiEnvironment => {
    const base = { name: r.node.name, roles: r.node.roles };
    const state = states.find((s) => s.node === r.node.name);
    const published = state === undefined ? null : { at: state.at, result: state.result, streak: state.streak, message: state.message };
    if (!r.ok) {
      return {
        ...base,
        reachable: false,
        error: r.error,
        platform: null,
        t3: { version: null, channel: null, behind: null },
        agents: [],
        providers: [],
        sync: published,
        providerAuth: [],
        models: null,
      };
    }
    const obs = r.observation;
    const version = obs.t3.descriptor?.serverVersion ?? obs.t3.installedVersion;
    const legacy = obs.legacySync;
    return {
      ...base,
      reachable: true,
      platform: `${obs.platform} ${obs.arch}`,
      t3: {
        version,
        channel: version === null ? null : cliReleaseChannelOf(version),
        behind: version === null ? null : releasesBehind(report.latest, version).behind,
      },
      agents: obs.agents.map((a) => ({ name: a.name, version: a.managedVersion, latest: report.latest.agents[a.name] })),
      providers: obs.t3.providers.map((p) => ({
        instanceId: p.instanceId,
        label: providerLabel(p.instanceId),
        enabled: p.enabled,
        startsInT3: p.launch.ok,
        version: p.launch.version,
        runs: p.resolved,
        viaModels: viaModelsLauncher(p.binaryPath),
      })),
      sync:
        published ??
        (legacy === null
          ? null
          : { at: legacy.when * 1000, result: legacy.result === "ok" ? "ok" : "fail", streak: legacy.streak, message: legacy.message }),
      providerAuth: obs.providerAuth,
      models: observedModels(obs),
    };
  });
  const findings = [...report.findings]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.node.localeCompare(b.node))
    .map((f) => toFinding(f, accepted));
  return {
    checkedAt,
    elapsedMs: report.elapsedMs,
    summary: renderStatus(report.results, report.findings, report.latest, { verbose: false, elapsedMs: report.elapsedMs }),
    environments,
    findings,
  };
};

/** Models traffic and Claude's login per machine, from the same check. */
export const toUiModels = (check: UiCheck): UiModels => ({
  nodes: check.report.results.map((r) =>
    r.ok
      ? { node: r.node.name, at: r.observation.observedAt, providerAuth: r.observation.providerAuth, stats: observedModels(r.observation) }
      : { node: r.node.name, at: null, providerAuth: [], stats: null },
  ),
});

// ── the server ──────────────────────────────────────────────────────────

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Why a request is refused, or null when it may proceed. */
export const refusal = (
  request: { readonly method: string; readonly headers: Readonly<Record<string, string | undefined>> },
  options: { readonly port: number; readonly token: string | null },
  query: URLSearchParams,
): { readonly status: number; readonly message: string } | null => {
  const allowed = LOOPBACK.map((h) => `${h}:${options.port}`);
  const host = request.headers["host"];
  if (host === undefined || !allowed.includes(host)) return { status: 421, message: "fleetx ui answers only on its loopback address" };
  const origin = request.headers["origin"];
  if (origin !== undefined && !allowed.some((h) => origin === `http://${h}`)) return { status: 403, message: "cross-origin requests are refused" };
  if (options.token === null) return null;
  const token = request.headers["x-fleetx-token"] ?? query.get("token") ?? "";
  if (token !== options.token) return { status: 401, message: "missing or stale token: open the link `fleetx ui` printed" };
  return null;
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const plain = (message: string, status: number) =>
  HttpServerResponse.text(message, { status, headers: SECURITY_HEADERS });

const jsonResponse = <S extends Schema.Top & { readonly EncodingServices: never }>(schema: S) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return (value: S["Type"]) =>
    encode(value).pipe(
      Effect.map((body) =>
        HttpServerResponse.text(body, { contentType: "application/json", headers: { ...SECURITY_HEADERS, "cache-control": "no-store" } }),
      ),
      Effect.orElseSucceed(() => plain("could not encode the response", 500)),
    );
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface ServerEvent {
  readonly type: string;
  readonly data: string;
}

/** The UI server's routes and background work, as one layer. */
export const uiLayer = (options: UiServerOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { actions } = options;
      const client = yield* HttpClient.HttpClient;
      const every = options.checkEvery ?? Duration.seconds(60);
      const latest = yield* Ref.make<{ readonly check: UiCheck; readonly status: UiStatus } | null>(null);
      const lastError = yield* Ref.make<string | null>(null);
      const clients = yield* Ref.make(0);
      const events = yield* PubSub.unbounded<ServerEvent>();
      const checking = yield* Semaphore.make(1);
      const applying = yield* Semaphore.make(1);
      const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(UiStatus));

      /** One full check at a time; the result is kept and announced as a "check" event. */
      const runCheck = checking.withPermits(1)(
        Effect.gen(function* () {
          const check = yield* actions.check.pipe(Effect.tapError((e) => Ref.set(lastError, e)));
          const status = toUiStatus(check, yield* Clock.currentTimeMillis);
          yield* Ref.set(latest, { check, status });
          yield* Ref.set(lastError, null);
          const data = yield* encodeStatus(status).pipe(Effect.orElseSucceed(() => ""));
          if (data !== "") yield* PubSub.publish(events, { type: "check", data });
          return { check, status };
        }),
      );

      /** The kept check, or a fresh one when there is none yet (or a previous one is still running). */
      const current = Effect.gen(function* () {
        const kept = yield* Ref.get(latest);
        if (kept !== null) return kept;
        return yield* checking.withPermits(1)(Ref.get(latest)).pipe(
          Effect.flatMap((after) => (after === null ? runCheck : Effect.succeed(after))),
        );
      });

      const stale = Effect.gen(function* () {
        const kept = yield* Ref.get(latest);
        return kept === null || (yield* Clock.currentTimeMillis) - kept.status.checkedAt >= Duration.toMillis(Duration.fromInputUnsafe(every));
      });

      // A check at start, then every minute while someone is looking.
      yield* runCheck.pipe(Effect.ignore, Effect.forkDetach);
      yield* Effect.gen(function* () {
        if ((yield* Ref.get(clients)) > 0 && (yield* stale)) yield* runCheck.pipe(Effect.ignore);
      }).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(5))), Effect.forkDetach);

      // Relay events pass through, so the app hears about syncs and the hub as they happen.
      if (options.relay !== null) {
        const relay = options.relay;
        let lastId = 0;
        yield* Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.get(`${relay.url}/events?since=${lastId}`).pipe(
              HttpClientRequest.bearerToken(relay.token),
              HttpClientRequest.setHeader("accept", "text/event-stream"),
            ),
          );
          if (response.status !== 200) return yield* Effect.fail(`relay answered ${response.status}`);
          let buffer = "";
          yield* response.stream.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                buffer += chunk;
                let end: number;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                  const frame = buffer.slice(0, end);
                  buffer = buffer.slice(end + 2);
                  const id = /^id: (\d+)$/m.exec(frame)?.[1];
                  const type = /^event: ([\w-]+)$/m.exec(frame)?.[1];
                  const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
                  if (id !== undefined) lastId = Number(id);
                  if (type !== undefined) yield* PubSub.publish(events, { type, data });
                }
              }),
            ),
          );
          return yield* Effect.fail("relay closed the stream");
        }).pipe(Effect.retry(Schedule.spaced(Duration.seconds(15))), Effect.ignore, Effect.forkDetach);
      }

      /** Guard, then run: every /api route goes through here. */
      const api = <E, R>(handler: (request: HttpServerRequest.HttpServerRequest, query: URLSearchParams) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const query = new URL(request.url, "http://ui").searchParams;
          const refused = refusal(request, options, query);
          if (refused !== null) return plain(refused.message, refused.status);
          return yield* handler(request, query);
        });

      const fail = (status: number) => (message: string) => Effect.succeed(plain(message, status));

      const session = HttpRouter.add("GET", "/api/session", api(() => jsonResponse(UiSession)(options.session)));

      const status = HttpRouter.add(
        "GET",
        "/api/status",
        api((_, query) =>
          (query.get("fresh") === "1" ? runCheck : current).pipe(
            Effect.flatMap((c) => jsonResponse(UiStatus)(c.status)),
            Effect.catch(fail(500)),
          ),
        ),
      );

      const decodeApply = Schema.decodeEffect(Schema.fromJsonString(UiApplyRequest));
      const fixes = HttpRouter.add(
        "POST",
        "/api/fixes",
        api((request) =>
          applying.withPermits(1)(
            Effect.gen(function* () {
              const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
              const asked = yield* decodeApply(body).pipe(Effect.mapError(() => "expected {\"ids\": [...]}"));
              const before = yield* runCheck;
              const byId = new Map(before.check.report.findings.map((f) => [findingId(f), f]));
              const chosen: Array<Finding & { readonly fix: Fix }> = [];
              const notApplied: Array<{ id: string; reason: string }> = [];
              for (const id of asked.ids) {
                const finding = byId.get(id);
                if (finding === undefined) notApplied.push({ id, reason: "no longer found; it may already be fixed" });
                else if (finding.fix === undefined) notApplied.push({ id, reason: "this finding has no automatic fix" });
                else chosen.push(finding as Finding & { readonly fix: Fix });
              }
              const outcomes = yield* actions.apply(chosen);
              const after = chosen.length === 0 ? before : yield* runCheck;
              return yield* jsonResponse(UiApplyResult)({
                results: outcomes.map((o) => ({ id: findingId(o.finding), node: o.finding.node, title: o.finding.title, ok: o.ok, output: o.summary })),
                notApplied,
                status: after.status,
              });
            }),
          ).pipe(Effect.catch(fail(400))),
        ),
      );

      const proposals = HttpRouter.add(
        "GET",
        "/api/proposals",
        api(() => actions.proposals.pipe(Effect.flatMap(jsonResponse(Schema.Array(UiProposal))), Effect.catch(fail(500)))),
      );

      const decide = (verb: "approve" | "reject") =>
        HttpRouter.add(
          "POST",
          `/api/proposals/:node/${verb}`,
          api(() =>
            Effect.gen(function* () {
              const node = (yield* HttpRouter.params)["node"] ?? "";
              if (!NAME.test(node)) return plain("not a machine name", 400);
              yield* (verb === "approve" ? actions.approve(node) : actions.reject(node));
              return HttpServerResponse.empty({ status: 204, headers: SECURITY_HEADERS });
            }).pipe(Effect.catch(fail(409))),
          ),
        );

      const alerts = HttpRouter.add(
        "GET",
        "/api/alerts",
        api(() => actions.alerts.pipe(Effect.flatMap(jsonResponse(Schema.Array(UiAlert))), Effect.catch(fail(500)))),
      );

      const models = HttpRouter.add(
        "GET",
        "/api/models",
        api(() => current.pipe(Effect.flatMap((c) => jsonResponse(UiModels)(toUiModels(c.check))), Effect.catch(fail(500)))),
      );

      const config = HttpRouter.add(
        "GET",
        "/api/config/:node",
        api(() =>
          Effect.gen(function* () {
            const node = (yield* HttpRouter.params)["node"] ?? "";
            if (!NAME.test(node)) return plain("not a machine name", 400);
            return yield* actions.config(node).pipe(Effect.flatMap(jsonResponse(Schema.Array(UiConfigRow))));
          }).pipe(Effect.catch(fail(404))),
        ),
      );

      /** Forward to the relay's hub, with the relay token, and check the answer's shape. */
      const hub = <S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never }>(
        method: "GET" | "POST",
        path: string,
        schema: S | null,
      ) =>
        Effect.gen(function* () {
          if (options.relay === null) return plain("this fleet has no relay, so no hub", 503);
          const response = yield* client
            .execute(HttpClientRequest.make(method)(`${options.relay.url}${path}`).pipe(HttpClientRequest.bearerToken(options.relay.token)))
            .pipe(Effect.timeout(Duration.seconds(15)), Effect.option);
          if (Option.isNone(response)) return plain("the relay did not answer", 502);
          const r = response.value;
          if (r.status === 404) return plain("the relay has no hub", 404);
          if (r.status < 200 || r.status >= 300) {
            const text = yield* r.text.pipe(Effect.orElseSucceed(() => ""));
            return plain(text.trim() || `the relay answered ${r.status}`, 502);
          }
          if (schema === null) return HttpServerResponse.empty({ status: 204, headers: SECURITY_HEADERS });
          const text = yield* r.text.pipe(Effect.orElseSucceed(() => ""));
          const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.option);
          if (Option.isNone(value)) return plain("the relay's answer was not understood", 502);
          return yield* jsonResponse(schema)(value.value);
        });

      const hubServers = HttpRouter.add("GET", "/api/hub/servers", api(() => hub("GET", "/hub/servers", Schema.Array(HubServer))));

      const hubCalls = HttpRouter.add(
        "GET",
        "/api/hub/calls",
        api((_, query) => {
          const forward = new URLSearchParams();
          const server = query.get("server");
          const limit = query.get("limit");
          if (server !== null && NAME.test(server)) forward.set("server", server);
          if (limit !== null && /^\d{1,5}$/.test(limit)) forward.set("limit", limit);
          const qs = forward.toString();
          return hub("GET", `/hub/calls${qs === "" ? "" : `?${qs}`}`, Schema.Array(HubCall));
        }),
      );

      const hubAction = (verb: "login" | "logout" | "restart") =>
        HttpRouter.add(
          "POST",
          `/api/hub/servers/:name/${verb}`,
          api(() =>
            Effect.gen(function* () {
              const name = (yield* HttpRouter.params)["name"] ?? "";
              if (!NAME.test(name)) return plain("not a server name", 400);
              return yield* verb === "login"
                ? hub("POST", `/hub/servers/${name}/login`, HubLoginStart)
                : hub("POST", `/hub/servers/${name}/${verb}`, null);
            }),
          ),
        );

      const eventStream = HttpRouter.add(
        "GET",
        "/api/events",
        api(() =>
          Effect.gen(function* () {
            yield* Ref.update(clients, (n) => n + 1);
            if (yield* stale) yield* runCheck.pipe(Effect.ignore, Effect.forkDetach);
            const frame = (e: ServerEvent) => `event: ${e.type}\ndata: ${e.data}\n\n`;
            const keepalive = Stream.tick(Duration.seconds(25)).pipe(Stream.map(() => ": keepalive\n\n"));
            const body = Stream.make(": connected\n\n").pipe(
              Stream.concat(Stream.merge(Stream.fromPubSub(events).pipe(Stream.map(frame)), keepalive)),
              Stream.ensuring(Ref.update(clients, (n) => n - 1)),
              Stream.encodeText,
            );
            return HttpServerResponse.stream(body, {
              contentType: "text/event-stream",
              headers: { ...SECURITY_HEADERS, "cache-control": "no-cache", connection: "keep-alive" },
            });
          }),
        ),
      );

      const unknownApi = HttpRouter.add("*", "/api/*", api(() => Effect.succeed(plain("no such endpoint", 404))));

      // The app. Any path without an asset gets index.html, so views have real URLs.
      const app = HttpRouter.add(
        "GET",
        "/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const refused = refusal(request, { port: options.port, token: null }, new URLSearchParams());
          if (refused !== null) return plain(refused.message, refused.status);
          const path = new URL(request.url, "http://ui").pathname;
          const asset = options.assets.get(path);
          const served = asset ?? (/\.[a-z0-9]+$/i.test(path) ? undefined : options.assets.get("/index.html"));
          if (served === undefined) {
            return plain(options.assets.size === 0 ? "this build of fleetx has no UI; build it with `pnpm --filter fleetx build`" : "not found", 404);
          }
          return HttpServerResponse.uint8Array(served.body, {
            contentType: served.type,
            headers: {
              ...SECURITY_HEADERS,
              "cache-control": asset !== undefined && path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            },
          });
        }),
      );

      return Layer.mergeAll(
        session,
        status,
        fixes,
        proposals,
        decide("approve"),
        decide("reject"),
        alerts,
        models,
        config,
        hubServers,
        hubCalls,
        hubAction("login"),
        hubAction("logout"),
        hubAction("restart"),
        eventStream,
        unknownApi,
        app,
      );
    }),
  );
