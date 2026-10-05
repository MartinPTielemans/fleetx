/**
 * The server behind `t3-fleet ui`: the built app and its /api, on 127.0.0.1.
 *
 *   POST /api/session    the link's one-use ticket, traded for this tab's token
 *   GET  /api/session, /api/status, /api/proposals, /api/alerts, /api/jobs,
 *        /api/models, /api/config/<node>, /api/hub/servers, /api/hub/calls,
 *        /api/skills
 *   POST /api/fixes/plan, /api/fixes, /api/proposals/<node>/approve | /reject,
 *        /api/hub/servers/<name>/login | /logout | /restart,
 *        /api/skills/lookup | /add | /preview | /update | /remove
 *   GET  /api/setup/state, POST /api/setup/probe | /plan | /apply | /invite
 *                        the setup wizard (SetupApi.ts)
 *   GET  /api/events     server-sent events: the latest status first, then the
 *                        relay's, plus "check", "check-failed", "job" and
 *                        "session"
 *   GET  *               the app
 *
 * Shapes are the ones in Api.ts, encoded here and decoded by the app.
 *
 * Other websites in the same browser must not be able to read the fleet or
 * drive fixes. `t3-fleet ui` opens the app with a ticket in the URL fragment;
 * the app trades it, once, for a token it sends as a header on every /api
 * request (a page on another origin cannot read it or set that header without
 * a CORS preflight, which is never granted). A ticket that comes back a second
 * time is refused loudly: someone else opened the link. Only the event stream
 * takes the token in its query, since EventSource cannot set headers. The Host
 * header must name this loopback port, so a DNS-rebinding page cannot pose as
 * the same origin, and an Origin, when sent, must be this one. The app may not
 * be framed, so it cannot be clickjacked.
 *
 * Checks run one at a time and are shared: whoever asks while one runs gets
 * its result. One runs at start, then every minute while a browser tab is
 * open and visible (a hidden tab closes its event stream). A check never
 * probes while fixes run, so it never reports a half-applied machine.
 *
 * Fixes are applied the way they were reviewed: the app asks for a plan (each
 * fix's exact command, with a digest), shows it, and sends the digests back;
 * the server checks again and runs only fixes whose digest still matches, and
 * those that interrupt something only if the user acknowledged it. Proposals
 * are approved or rejected by the change that was shown (see Api.ts
 * UiProposal.change).
 *
 * Whatever changes a machine or the repo runs as a job in the server, not in
 * the request: closing the tab does not stop it, and its progress is an event
 * any tab can follow. Stopping the server waits for running jobs (the caller
 * hears which, through onDrain); finished ones are listed for half an hour.
 *
 * Skill changes edit the config repo the way `t3-fleet skills` does, one at a
 * time: an authority commits them, any other machine's next sync proposes
 * them. Linking them on each machine stays a fix, shown before it runs. An
 * update is previewed first and kept only if upstream still gives the same
 * change.
 *
 * On a machine not in a fleet yet (or whose setup stopped part-way) the same
 * server serves the setup wizard: `inFleet` is false, so no check runs, and
 * the session names the machine setup would make. Apply runs setup as jobs
 * ("setup", then "setup-hub" when a hub was asked for), one run at a time.
 * Nothing restarts when it is done: the session, the relay and the checks are
 * read as they are now, so once the "setup" job is done the same server is
 * the fleet's. It says so with a "session" event carrying the new session;
 * the app reloads into the fleet's views on it.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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
  UiCheckFailed,
  UiConfigRow,
  UiDecideRequest,
  UiFixPlan,
  UiFixPlanRequest,
  UiJob,
  UiModels,
  UiProposal,
  UiSession,
  UiSessionGrant,
  UiSkills,
  UiSkillsAddRequest,
  UiSkillsKeepRequest,
  UiSkillsLanded,
  UiSkillsLookup,
  UiSkillsLookupRequest,
  UiSkillsNames,
  UiSkillsPreview,
  UiStatus,
  type UiApplyResult,
  type UiEnvironment,
  type UiFinding,
  type UiJobKind,
  type UiPlannedFix,
  type UiSkill,
  type UiSkillsNode,
} from "./Api.ts";
import { Desired as SkillsDesired, Observed as SkillsObserved } from "./areas/Skills.ts";
import type { CheckReport } from "./Check.ts";
import { providerLabel, type Finding, type Fix } from "./Diagnose.ts";
import { fixDigest, type FixOutcome } from "./Fix.ts";
import { constantTimeEqual } from "./hub/Policy.ts";
import { identify, refusedPage, type HubGate } from "./HubUi.ts";
import { releasesBehind } from "./Latest.ts";
import { findingId } from "./Memory.ts";
import type { MachineObservation } from "./Observation.ts";
import { renderStatus } from "./Render.ts";
import type { NodeState } from "./State.ts";
import { cliReleaseChannelOf } from "./vendor/t3/cliRelease.ts";
import { isLauncher } from "./Names.ts";
import {
  UiInvite,
  UiInviteRequest,
  UiProbe,
  UiProbeRequest,
  UiSetupApplyRequest,
  UiSetupPlan,
  UiSetupPlanRequest,
  UiSetupStarted,
  UiSetupState,
} from "./SetupApi.ts";
import type { SetupActions, SetupJob } from "./setup/Wizard.ts";

export { fixDigest } from "./Fix.ts";

/** A full check, with what it needs to be shown: published sync states and accepted differences. */
export interface UiCheck {
  readonly report: CheckReport;
  readonly states: ReadonlyArray<NodeState>;
  readonly accepted: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/** What the server does on the fleet; `t3-fleet ui` wires these to the real engine, tests to fakes. */
export interface UiActions {
  readonly check: Effect.Effect<UiCheck, string>;
  /** `step` says how it goes, for the job (the hub waits on other machines). */
  readonly apply: (
    fixes: ReadonlyArray<Finding & { readonly fix: Fix }>,
    step: (text: string) => Effect.Effect<void>,
  ) => Effect.Effect<ReadonlyArray<FixOutcome>>;
  readonly proposals: Effect.Effect<ReadonlyArray<UiProposal>, string>;
  /** Approve `node`'s proposal, failing unless it still makes the reviewed `change` (UiProposal.change). */
  /** What approving did besides (the secrets it merged), a line each. */
  readonly approve: (node: string, change: string) => Effect.Effect<ReadonlyArray<string>, string>;
  readonly reject: (node: string, change: string) => Effect.Effect<void, string>;
  readonly alerts: Effect.Effect<ReadonlyArray<typeof UiAlert.Type>, string>;
  readonly config: (node: string) => Effect.Effect<ReadonlyArray<UiConfigRow>, string>;
  readonly skills: {
    /** The repo's skills. */
    readonly list: Effect.Effect<ReadonlyArray<UiSkill>, string>;
    readonly lookup: (source: string) => Effect.Effect<UiSkillsLookup, string>;
    readonly add: (
      source: string,
      skills: ReadonlyArray<string>,
      as: string | undefined,
    ) => Effect.Effect<UiSkillsLanded, string>;
    readonly preview: (skills: ReadonlyArray<string>) => Effect.Effect<UiSkillsPreview, string>;
    readonly update: (
      skills: ReadonlyArray<string>,
      digest: string,
    ) => Effect.Effect<UiSkillsLanded, string>;
    readonly remove: (skills: ReadonlyArray<string>) => Effect.Effect<UiSkillsLanded, string>;
  };
}
type UiConfigRow = typeof UiConfigRow.Type;

export interface UiRelay {
  readonly url: string;
  readonly token: string;
}

export interface UiAsset {
  readonly type: string;
  readonly body: Uint8Array;
}

/** The app served by the hub instead of on this machine's loopback (HubUi.ts). */
export interface UiHubAccess {
  /** Who may open it, read as it is now. */
  readonly gate: Effect.Effect<HubGate>;
  /** The authorities: proposals are decided there, never on the hub. */
  readonly approveOn: Effect.Effect<ReadonlyArray<string>>;
}

export interface UiServerOptions {
  /** The one-use ticket in the link `t3-fleet ui` opens; the app trades it for a token. Unused on the hub. */
  readonly ticket: string;
  /** Called with a new ticket each time one is used, so the user can open another tab. */
  readonly onTicketUsed?: (next: string) => Effect.Effect<void>;
  /** The port the server listens on, for the Host check. Unused on the hub. */
  readonly port: number;
  /**
   * Served by the hub: Tailscale identity in place of the ticket and the
   * loopback Host, and no approving or rejecting proposals.
   */
  readonly hub?: UiHubAccess;
  /** The built app, by URL path ("/index.html", "/assets/…"). */
  readonly assets: ReadonlyMap<string, UiAsset>;
  /** This machine and its fleet; read as it is now when given as an effect (it changes once setup is done). */
  readonly session: UiSession | Effect.Effect<UiSession>;
  readonly actions: UiActions;
  /** The relay and its token, when the fleet has one; read as it is now when given as an effect. */
  readonly relay: UiRelay | null | Effect.Effect<UiRelay | null>;
  /** Whether this machine is in a fleet yet; checks run only once it is. Always, unless given. */
  readonly inFleet?: Effect.Effect<boolean>;
  /** The setup wizard's engine; without it, the /api/setup routes answer 404. */
  readonly setup?: SetupActions;
  readonly checkEvery?: Duration.Input;
  /** How long finished jobs stay listed; half an hour unless a test says otherwise. */
  readonly keepJobsFor?: Duration.Input;
  /** Called when the server stops while jobs run, with their titles, before it waits for them. */
  readonly onDrain?: (running: ReadonlyArray<string>) => Effect.Effect<void>;
}

// ── turning a check into what the UI shows ──────────────────────────────

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The models area's launchers are ~/.local/bin/t3-fleet-<provider> (docs/design/companion.md). */
const viaModelsLauncher = (binaryPath: string | null) =>
  binaryPath !== null && isLauncher(basename(binaryPath));

/**
 * The model proxy's stats, as the models area reports them in an observation:
 * read loosely, as top-level `models` or the area's `stats`, so a node on an
 * older T3 Fleet is "not reported" rather than an error.
 */
const observed = <S extends Schema.Top & { readonly DecodingServices: never }>(
  obs: MachineObservation,
  key: string,
  schema: S,
): S["Type"] | null => {
  const top = (obs as unknown as Readonly<Record<string, unknown>>)[key];
  const area = obs.areas["models"];
  const nested =
    typeof area === "object" && area !== null
      ? (area as Readonly<Record<string, unknown>>)[key]
      : undefined;
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
    const published =
      state === undefined
        ? null
        : { at: state.at, result: state.result, streak: state.streak, message: state.message };
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
    const legacy = obs.lastSync;
    return {
      ...base,
      reachable: true,
      platform: `${obs.platform} ${obs.arch}`,
      t3: {
        version,
        channel: version === null ? null : cliReleaseChannelOf(version),
        behind: version === null ? null : releasesBehind(report.latest, version).behind,
      },
      agents: obs.agents.map((a) => ({
        name: a.name,
        version: a.managedVersion,
        latest: report.latest.agents[a.name],
      })),
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
          : {
              at: legacy.when * 1000,
              result: legacy.result === "ok" ? "ok" : "fail",
              streak: legacy.streak,
              message: legacy.message,
            }),
      providerAuth: obs.providerAuth,
      models: observedModels(obs),
    };
  });
  const findings = [...report.findings]
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.node.localeCompare(b.node),
    )
    .map((f) => toFinding(f, accepted));
  return {
    checkedAt,
    elapsedMs: report.elapsedMs,
    summary: renderStatus(report.results, report.findings, report.latest, {
      verbose: false,
      elapsedMs: report.elapsedMs,
    }),
    environments,
    findings,
  };
};

/** Models traffic and Claude's login per machine, from the same check. */
export const toUiModels = (check: UiCheck): UiModels => ({
  nodes: check.report.results.map((r) =>
    r.ok
      ? {
          node: r.node.name,
          at: r.observation.observedAt,
          providerAuth: r.observation.providerAuth,
          stats: observedModels(r.observation),
        }
      : { node: r.node.name, at: null, providerAuth: [], stats: null },
  ),
});

/** The repo's skills, and how each machine's last check found them linked. */
export const toUiSkills = (check: UiCheck, skills: ReadonlyArray<UiSkill>): UiSkills => ({
  skills,
  nodes: check.report.results.map((r): UiSkillsNode => {
    const desired = Schema.decodeUnknownOption(SkillsDesired)(r.node.settings.table["skills"]);
    const ignored = Option.isSome(desired) ? [...(desired.value?.ignore ?? [])] : [];
    const seen = r.ok
      ? Schema.decodeUnknownOption(SkillsObserved)(r.observation.areas["skills"])
      : Option.none();
    if (!r.ok || Option.isNone(seen))
      return {
        node: r.node.name,
        at: r.ok ? r.observation.observedAt : null,
        store: null,
        links: [],
        strays: [],
        dangling: [],
        ignored,
      };
    const { store, links, strays, dangling } = seen.value;
    return {
      node: r.node.name,
      at: r.observation.observedAt,
      store,
      links,
      strays,
      dangling,
      ignored,
    };
  }),
});

// ── the server ──────────────────────────────────────────────────────────

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

/** Why a request is refused, or null when it may proceed. */
export const refusal = (
  request: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
  },
  options: {
    readonly port: number;
    /** The tokens this run handed out; null for what needs none (the app itself, trading a ticket). */
    readonly tokens: ReadonlySet<string> | null;
    /** Whether the token may come in the query instead of a header: the event stream only. */
    readonly queryToken?: boolean;
  },
  query: URLSearchParams,
): { readonly status: number; readonly message: string } | null => {
  const allowed = LOOPBACK.map((h) => `${h}:${options.port}`);
  const host = request.headers["host"];
  if (host === undefined || !allowed.includes(host))
    return { status: 421, message: "t3-fleet ui answers only on its loopback address" };
  const origin = request.headers["origin"];
  if (origin !== undefined && !allowed.some((h) => origin === `http://${h}`))
    return { status: 403, message: "cross-origin requests are refused" };
  if (options.tokens === null) return null;
  const given =
    request.headers["x-t3-fleet-token"] ??
    (options.queryToken === true ? query.get("token") : null) ??
    "";
  let ok = false;
  for (const token of options.tokens) if (constantTimeEqual(given, token)) ok = true;
  if (!ok)
    return { status: 401, message: "missing or stale token: open the link `t3-fleet ui` printed" };
  return null;
};

/** On the hub: the token must be one this run handed to the same login. */
const tokenRefusal = (
  request: { readonly headers: Readonly<Record<string, string | undefined>> },
  query: URLSearchParams,
  handed: ReadonlyMap<string, string | null>,
  login: string | null,
  queryToken: boolean,
): { readonly status: number; readonly message: string } | null => {
  const given =
    request.headers["x-t3-fleet-token"] ?? (queryToken ? query.get("token") : null) ?? "";
  let owner: string | null | undefined;
  for (const [token, who] of handed) if (constantTimeEqual(given, token)) owner = who;
  if (owner === undefined || owner === null || owner !== login)
    return { status: 401, message: "missing or stale session: reload the app" };
  return null;
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const plain = (message: string, status: number) =>
  HttpServerResponse.text(message, { status, headers: SECURITY_HEADERS });

const jsonResponse = <S extends Schema.Top & { readonly EncodingServices: never }>(
  schema: S,
  status = 200,
) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return (value: S["Type"]) =>
    encode(value).pipe(
      Effect.map((body) =>
        HttpServerResponse.text(body, {
          status,
          contentType: "application/json",
          headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
        }),
      ),
      Effect.orElseSucceed(() => plain("could not encode the response", 500)),
    );
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What `t3-fleet skills add` takes: owner/repo, or an https or ssh git URL. */
const SKILL_SOURCE = /^(?:[\w.-]+\/[\w.-]+|https:\/\/[^\s]+|git@[\w.-]+:[^\s]+|ssh:\/\/[^\s]+)$/;

/** A random hex string, from Web Crypto as Hash.ts uses it. */
const randomHex = (bytes: number) =>
  Effect.sync(() =>
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  );

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How long finished jobs stay listed, for a tab that reloads or opens later. */
const JOBS_KEPT = Duration.minutes(30);

/** One per id: a request naming a fix twice runs it once. */
export const uniqueFixes = <F extends { readonly id: string; readonly digest: string }>(
  fixes: ReadonlyArray<F>,
): ReadonlyArray<F> | string => {
  const byId = new Map<string, F>();
  for (const fix of fixes) {
    const seen = byId.get(fix.id);
    if (seen === undefined) byId.set(fix.id, fix);
    else if (seen.digest !== fix.digest)
      return `${fix.id} is asked for twice, as two different fixes`;
  }
  return [...byId.values()];
};

interface ServerEvent {
  readonly id: number;
  readonly type: string;
  readonly data: string;
}

interface Kept {
  readonly check: UiCheck;
  readonly status: UiStatus;
}

type JobResult = Pick<UiJob, "applied" | "landed">;

/** The UI server's routes and background work, as one layer. */
export const uiLayer = (options: UiServerOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { actions } = options;
      const client = yield* HttpClient.HttpClient;
      const sessionNow: Effect.Effect<UiSession> = Effect.isEffect(options.session)
        ? options.session
        : Effect.succeed(options.session);
      const relayNow: Effect.Effect<UiRelay | null> = Effect.isEffect(options.relay)
        ? options.relay
        : Effect.succeed(options.relay);
      const inFleet = options.inFleet ?? Effect.succeed(true);
      /** A check nobody asked for runs only on a machine in a fleet. */
      const whenInFleet = <E>(effect: Effect.Effect<unknown, E>) =>
        inFleet.pipe(Effect.flatMap((yes) => (yes ? Effect.ignore(effect) : Effect.void)));
      // Background work (checks, the relay, jobs) runs here rather than in the layer's own
      // scope, so stopping the server can wait for jobs before anything is interrupted.
      const scope = yield* Scope.make();
      const keepJobsMs = Duration.toMillis(
        Duration.fromInputUnsafe(options.keepJobsFor ?? JOBS_KEPT),
      );
      const everyMs = Duration.toMillis(
        Duration.fromInputUnsafe(options.checkEvery ?? Duration.seconds(60)),
      );
      const latest = yield* Ref.make<Kept | null>(null);
      const lastError = yield* Ref.make<UiCheckFailed | null>(null);
      const inflight = yield* Ref.make<Deferred.Deferred<Kept, string> | null>(null);
      const clients = yield* Ref.make(0);
      const events = yield* PubSub.unbounded<ServerEvent>();
      const eventId = yield* Ref.make(0);
      const jobs = yield* Ref.make<ReadonlyMap<string, UiJob>>(new Map());
      /** Each running job's end, by id, for stopping the server. */
      const running = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
      /** The tokens this run handed out, each with the login it was handed to (null: by ticket). */
      const tokens = yield* Ref.make<ReadonlyMap<string, string | null>>(new Map());
      const ticket = yield* Ref.make(options.ticket);
      const usedTickets = yield* Ref.make<ReadonlySet<string>>(new Set());
      /** Guards starting a check, so two callers never start two. */
      const starting = yield* Semaphore.make(1);
      /** Held while a check probes and while fixes run: a check never sees a half-applied machine. */
      const machines = yield* Semaphore.make(1);
      /** One fix job at a time, from its first check to its last. */
      const applying = yield* Semaphore.make(1);
      /** One change to the config repo at a time: skills, approvals, rejections. */
      const editingRepo = yield* Semaphore.make(1);
      const encodeStatus = Schema.encodeEffect(Schema.fromJsonString(UiStatus));
      const encodeFailed = Schema.encodeEffect(Schema.fromJsonString(UiCheckFailed));
      const encodeJob = Schema.encodeEffect(Schema.fromJsonString(UiJob));

      const publish = (type: string, data: string) =>
        Ref.updateAndGet(eventId, (n) => n + 1).pipe(
          Effect.flatMap((id) => PubSub.publish(events, { id, type, data })),
        );

      // ── checks ──

      /** One full check, kept and announced; a failure is kept and announced too. */
      const probe = machines
        .withPermits(1)(
          Effect.gen(function* () {
            const check = yield* actions.check;
            return {
              check,
              status: toUiStatus(check, yield* Clock.currentTimeMillis),
            } satisfies Kept;
          }),
        )
        .pipe(
          Effect.tap((kept) =>
            Effect.gen(function* () {
              yield* Ref.set(latest, kept);
              yield* Ref.set(lastError, null);
              const data = yield* encodeStatus(kept.status).pipe(Effect.orElseSucceed(() => ""));
              if (data !== "") yield* publish("check", data);
            }),
          ),
          Effect.tapError((message) =>
            Effect.gen(function* () {
              const failed = { at: yield* Clock.currentTimeMillis, message };
              yield* Ref.set(lastError, failed);
              const data = yield* encodeFailed(failed).pipe(Effect.orElseSucceed(() => ""));
              if (data !== "") yield* publish("check-failed", data);
            }),
          ),
        );

      /**
       * The kept check if it is younger than `maxAgeMs`, else the one running,
       * else a new one. Everyone who asks while a check runs shares it, and the
       * check runs in the server, so a caller that goes away does not stop it.
       */
      const checked = (maxAgeMs: number) =>
        Effect.gen(function* () {
          const next = yield* starting.withPermits(1)(
            Effect.gen(function* () {
              const kept = yield* Ref.get(latest);
              if (
                kept !== null &&
                (yield* Clock.currentTimeMillis) - kept.status.checkedAt < maxAgeMs
              )
                return { kept };
              const running = yield* Ref.get(inflight);
              if (running !== null) return { wait: running };
              const done = yield* Deferred.make<Kept, string>();
              yield* Ref.set(inflight, done);
              yield* probe.pipe(
                Effect.onExit((exit) =>
                  Ref.set(inflight, null).pipe(Effect.andThen(Deferred.done(done, exit))),
                ),
                Effect.ignore,
                Effect.forkIn(scope),
              );
              return { wait: done };
            }),
          );
          return "kept" in next ? next.kept : yield* Deferred.await(next.wait);
        });

      /** The kept check, or the first one when there is none yet. */
      const current = checked(Number.POSITIVE_INFINITY);

      // A check at start, then every minute while a tab is looking.
      yield* whenInFleet(checked(0)).pipe(Effect.forkIn(scope));
      yield* Effect.gen(function* () {
        if ((yield* Ref.get(clients)) > 0) yield* whenInFleet(checked(everyMs));
      }).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(5))), Effect.forkIn(scope));

      // ── jobs ──

      const announce = (job: UiJob) =>
        encodeJob(job).pipe(
          Effect.flatMap((data) => publish("job", data)),
          Effect.ignore,
        );

      const updateJob = (id: string, change: (job: UiJob) => UiJob) =>
        Ref.modify(jobs, (all): [UiJob | null, ReadonlyMap<string, UiJob>] => {
          const job = all.get(id);
          if (job === undefined) return [null, all];
          const next = change(job);
          return [next, new Map(all).set(id, next)];
        }).pipe(Effect.flatMap((job) => (job === null ? Effect.void : announce(job))));

      /**
       * Start `work` as a job: it waits for `lock`, runs in the server's scope
       * rather than the request's, and reports each step as a "job" event.
       */
      const startJob = (
        kind: UiJobKind,
        title: string,
        lock: Semaphore.Semaphore,
        work: (
          step: (text: string) => Effect.Effect<void>,
        ) => Effect.Effect<Partial<JobResult>, string>,
      ) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const job: UiJob = {
            id: yield* randomHex(8),
            kind,
            title,
            state: "waiting",
            step: "waiting for another change to finish",
            startedAt: now,
            finishedAt: null,
            error: null,
            applied: null,
            landed: null,
          };
          yield* Ref.update(jobs, (all) => new Map(all).set(job.id, job));
          yield* announce(job);
          const step = (text: string) =>
            updateJob(job.id, (j) => ({ ...j, state: "running", step: text }));
          const ended = yield* Deferred.make<void>();
          yield* Ref.update(running, (all) => new Map(all).set(job.id, ended));
          yield* lock
            .withPermits(1)(step("starting").pipe(Effect.andThen(work(step))))
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((at) =>
                      updateJob(job.id, (j) => ({
                        ...j,
                        state: "failed",
                        step: null,
                        finishedAt: at,
                        error,
                      })),
                    ),
                  ),
                onSuccess: (result) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((at) =>
                      updateJob(job.id, (j) => ({
                        ...j,
                        ...result,
                        state: "done",
                        step: null,
                        finishedAt: at,
                      })),
                    ),
                  ),
              }),
              Effect.ensuring(
                Ref.update(running, (all) => {
                  const rest = new Map(all);
                  rest.delete(job.id);
                  return rest;
                }).pipe(Effect.andThen(Deferred.succeed(ended, undefined))),
              ),
              Effect.forkIn(scope),
            );
          return job;
        });

      /** Finished jobs older than keepJobsFor are dropped, checked every few seconds. */
      const pruneJobs = Effect.gen(function* () {
        const keepAfter = (yield* Clock.currentTimeMillis) - keepJobsMs;
        yield* Ref.update(
          jobs,
          (all) =>
            new Map([...all].filter(([, j]) => j.finishedAt === null || j.finishedAt > keepAfter)),
        );
      });
      yield* pruneJobs.pipe(
        Effect.repeat(
          Schedule.spaced(Duration.millis(Math.min(5000, Math.max(10, keepJobsMs / 2)))),
        ),
        Effect.forkIn(scope),
      );

      // Stopping the server (Ctrl-C) waits for running jobs: one stopped mid-script leaves a machine half-fixed.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const left = [...(yield* Ref.get(jobs)).values()].filter((j) => j.finishedAt === null);
          const ends = [...(yield* Ref.get(running)).values()];
          if (ends.length > 0) {
            if (options.onDrain !== undefined) yield* options.onDrain(left.map((j) => j.title));
            yield* Effect.forEach(ends, Deferred.await, { discard: true });
          }
          yield* Scope.close(scope, Exit.void);
        }),
      );

      // Relay events pass through, so the app hears about syncs and the hub as they happen;
      // a relay that comes later (setup made one) is picked up on the next try.
      if (options.relay !== null) {
        let lastId = 0;
        yield* Effect.gen(function* () {
          const relay = yield* relayNow;
          if (relay === null) return yield* Effect.fail("no relay yet");
          const response = yield* client.execute(
            HttpClientRequest.get(`${relay.url}/events?since=${lastId}`).pipe(
              HttpClientRequest.bearerToken(relay.token),
              HttpClientRequest.setHeader("accept", "text/event-stream"),
            ),
          );
          if (response.status !== 200)
            return yield* Effect.fail(`relay answered ${response.status}`);
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
                  // The relay's own names only; the server's events are its own.
                  if (
                    type !== undefined &&
                    type !== "check" &&
                    type !== "check-failed" &&
                    type !== "job"
                  )
                    yield* publish(type, data);
                }
              }),
            ),
          );
          return yield* Effect.fail("relay closed the stream");
        }).pipe(
          Effect.retry(Schedule.spaced(Duration.seconds(15))),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      }

      // ── routes ──

      /**
       * Who is asking: on the hub, the Tailscale login (HubUi.ts); here, nobody
       * in particular (null). A refusal is the response to send.
       */
      const identity = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          if (options.hub === undefined) return { login: null } as const;
          const who = identify(
            { headers: request.headers, remoteAddress: Option.getOrNull(request.remoteAddress) },
            yield* options.hub.gate,
          );
          return who.ok ? ({ login: who.login } as const) : ({ refused: who } as const);
        });

      /** Guard, then run: every /api route goes through here. */
      const api = <E, R>(
        handler: (
          request: HttpServerRequest.HttpServerRequest,
          query: URLSearchParams,
        ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
        guard: { readonly queryToken?: boolean; readonly ticket?: boolean } = {},
      ) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const query = new URL(request.url, "http://ui").searchParams;
          const who = yield* identity(request);
          if ("refused" in who) return plain(who.refused.message, who.refused.status);
          const handed = yield* Ref.get(tokens);
          const refused =
            options.hub === undefined
              ? refusal(
                  request,
                  {
                    port: options.port,
                    tokens: guard.ticket === true ? null : new Set(handed.keys()),
                    queryToken: guard.queryToken === true,
                  },
                  query,
                )
              : guard.ticket === true
                ? null
                : tokenRefusal(request, query, handed, who.login, guard.queryToken === true);
          if (refused !== null) return plain(refused.message, refused.status);
          return yield* handler(request, query);
        });

      const fail = (status: number) => (message: string) => Effect.succeed(plain(message, status));

      /** Decode a JSON body, or fail with `what` was expected. */
      const body = <S extends Schema.Top & { readonly DecodingServices: never }>(
        schema: S,
        what = "the request was not understood",
      ) => {
        const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
        return (request: HttpServerRequest.HttpServerRequest) =>
          request.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap(decode),
            Effect.mapError(() => what),
          );
      };

      const accepted = jsonResponse(UiJob, 202);

      // The ticket is good once. A second use means the link went somewhere else too.
      // On the hub there is no ticket: a login the gate lets in gets a token of its own.
      const trade = HttpRouter.add(
        "POST",
        "/api/session",
        api(
          (request) =>
            Effect.gen(function* () {
              if (options.hub !== undefined) {
                // A header no form can send: a page elsewhere cannot get a token without a preflight.
                if (request.headers["x-t3-fleet-hub"] !== "1")
                  return plain("ask for a session from the app", 400);
                const who = yield* identity(request);
                if ("refused" in who) return plain(who.refused.message, who.refused.status);
                const token = yield* randomHex(24);
                yield* Ref.update(tokens, (all) => new Map(all).set(token, who.login));
                return yield* jsonResponse(UiSessionGrant)({ token });
              }
              const given = request.headers["x-t3-fleet-ticket"] ?? "";
              const expected = yield* Ref.get(ticket);
              if (!constantTimeEqual(given, expected)) {
                const reused = given !== "" && (yield* Ref.get(usedTickets)).has(given);
                return reused
                  ? plain(
                      "this link was already used. If that was not you, someone else on this machine opened it: stop t3-fleet ui. For another tab, use the newest link it printed.",
                      410,
                    )
                  : plain("not this run's link: open the link `t3-fleet ui` printed", 401);
              }
              const token = yield* randomHex(24);
              const next = yield* randomHex(24);
              yield* Ref.update(tokens, (all) => new Map(all).set(token, null));
              yield* Ref.update(usedTickets, (all) => new Set(all).add(given));
              yield* Ref.set(ticket, next);
              if (options.onTicketUsed !== undefined) yield* options.onTicketUsed(next);
              return yield* jsonResponse(UiSessionGrant)({ token });
            }),
          { ticket: true },
        ),
      );

      const session = HttpRouter.add(
        "GET",
        "/api/session",
        api((request) =>
          Effect.gen(function* () {
            const now = yield* sessionNow;
            if (options.hub === undefined) return yield* jsonResponse(UiSession)(now);
            const who = yield* identity(request);
            return yield* jsonResponse(UiSession)({
              ...now,
              hub: {
                login: "login" in who && who.login !== null ? who.login : "",
                approveOn: [...(yield* options.hub.approveOn)],
              },
            });
          }),
        ),
      );

      const status = HttpRouter.add(
        "GET",
        "/api/status",
        api((_, query) =>
          checked(query.get("fresh") === "1" ? 0 : Number.POSITIVE_INFINITY).pipe(
            Effect.flatMap((c) => jsonResponse(UiStatus)(c.status)),
            Effect.catch(fail(500)),
          ),
        ),
      );

      /** Each asked-for finding's fix as it stands in `check`, with its digest, or why there is none. */
      const plan = (check: UiCheck, ids: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const byId = new Map(check.report.findings.map((f) => [findingId(f), f]));
          const fixes: Array<{
            readonly planned: UiPlannedFix;
            readonly finding: Finding & { readonly fix: Fix };
          }> = [];
          const notApplicable: Array<{ id: string; reason: string }> = [];
          for (const id of new Set(ids)) {
            const finding = byId.get(id);
            if (finding === undefined)
              notApplicable.push({ id, reason: "no longer found; it may already be fixed" });
            else if (finding.fix === undefined)
              notApplicable.push({ id, reason: "this finding has no automatic fix" });
            else {
              const fixable = finding as Finding & { readonly fix: Fix };
              const { command, safe, disrupts, on } = fixable.fix;
              fixes.push({
                finding: fixable,
                planned: {
                  id,
                  node: finding.node,
                  title: finding.title,
                  command,
                  safe,
                  ...(disrupts === undefined ? {} : { disrupts }),
                  ...(on === undefined ? {} : { on }),
                  digest: yield* fixDigest(fixable),
                },
              });
            }
          }
          return { fixes, notApplicable };
        });

      const fixPlan = HttpRouter.add(
        "POST",
        "/api/fixes/plan",
        api((request) =>
          Effect.gen(function* () {
            const asked = yield* body(UiFixPlanRequest, 'expected {"ids": [...]}')(request);
            const planned = yield* plan((yield* current).check, asked.ids);
            return yield* jsonResponse(UiFixPlan)({
              fixes: planned.fixes.map((f) => f.planned),
              notApplicable: planned.notApplicable,
            });
          }).pipe(Effect.catch(fail(400))),
        ),
      );

      /** Check again, run only the fixes still exactly as reviewed, check again. */
      const applyJob =
        (asked: typeof UiApplyRequest.Type) => (step: (text: string) => Effect.Effect<void>) =>
          Effect.gen(function* () {
            yield* step("checking every machine first");
            const before = yield* checked(0);
            const now = yield* plan(
              before.check,
              asked.fixes.map((f) => f.id),
            );
            const notApplied = [...now.notApplicable];
            const chosen: Array<Finding & { readonly fix: Fix }> = [];
            for (const reviewed of asked.fixes) {
              const fix = now.fixes.find((f) => f.planned.id === reviewed.id);
              if (fix === undefined) continue;
              if (fix.planned.digest !== reviewed.digest)
                notApplied.push({
                  id: reviewed.id,
                  reason: "changed since you reviewed it; review it again",
                });
              else if (
                fix.planned.disrupts !== undefined &&
                !asked.acknowledged.includes(reviewed.id)
              ) {
                notApplied.push({
                  id: reviewed.id,
                  reason: `interrupts ${fix.planned.disrupts}, and that was not confirmed`,
                });
              } else chosen.push(fix.finding);
            }
            let outcomes: ReadonlyArray<FixOutcome> = [];
            if (chosen.length > 0) {
              yield* step(`running ${plural(chosen.length, "fix", "fixes")}`);
              outcomes = yield* machines.withPermits(1)(actions.apply(chosen, step));
              yield* step("checking every machine again");
              yield* checked(0).pipe(Effect.ignore);
            }
            const applied: UiApplyResult = {
              results: outcomes.map((o) => ({
                id: findingId(o.finding),
                node: o.finding.node,
                title: o.finding.title,
                ok: o.ok,
                output: o.summary,
              })),
              notApplied,
            };
            return { applied };
          });

      const fixes = HttpRouter.add(
        "POST",
        "/api/fixes",
        api((request) =>
          Effect.gen(function* () {
            const request_ = yield* body(
              UiApplyRequest,
              'expected {"fixes": [{"id", "digest"}], "acknowledged": [...]}',
            )(request);
            const unique = uniqueFixes(request_.fixes);
            if (typeof unique === "string") return plain(unique, 400);
            if (unique.length === 0) return plain("no fixes asked for", 400);
            const asked = { ...request_, fixes: unique };
            const machinesNamed = new Set(asked.fixes.map((f) => f.id.slice(0, f.id.indexOf(":"))))
              .size;
            const job = yield* startJob(
              "fixes",
              `Apply ${plural(asked.fixes.length, "fix", "fixes")} on ${plural(machinesNamed, "machine")}`,
              applying,
              applyJob(asked),
            );
            return yield* accepted(job);
          }).pipe(Effect.catch(fail(400))),
        ),
      );

      const proposals = HttpRouter.add(
        "GET",
        "/api/proposals",
        api(() =>
          actions.proposals.pipe(
            Effect.flatMap(jsonResponse(Schema.Array(UiProposal))),
            Effect.catch(fail(500)),
          ),
        ),
      );

      const decide = (verb: "approve" | "reject") =>
        HttpRouter.add(
          "POST",
          `/api/proposals/:node/${verb}`,
          api((request) =>
            Effect.gen(function* () {
              // The hub shows proposals but never decides them: a hub that could would approve its own.
              if (options.hub !== undefined) {
                const on = yield* options.hub.approveOn;
                return plain(
                  `proposals are approved and rejected on an authority (${on.join(", ") || "none in this fleet"}), not in the app on the hub`,
                  403,
                );
              }
              const node = (yield* HttpRouter.params)["node"] ?? "";
              if (!NAME.test(node)) return plain("not a machine name", 400);
              const { change } = yield* body(
                UiDecideRequest,
                'expected {"change": "<the change you reviewed>"}',
              )(request);
              if (!/^[0-9a-f]{64}$/.test(change)) return plain("not a change digest", 400);
              const job = yield* startJob(
                verb,
                `${verb === "approve" ? "Approve" : "Reject"} ${node}'s proposal`,
                editingRepo,
                (step) =>
                  step(
                    verb === "approve"
                      ? "landing the proposal on the branch"
                      : "moving the proposal aside",
                  ).pipe(
                    Effect.andThen(
                      verb === "approve"
                        ? actions
                            .approve(node, change)
                            .pipe(Effect.flatMap((notes) => Effect.forEach(notes, (n) => step(n))))
                        : actions.reject(node, change),
                    ),
                    Effect.as({}),
                  ),
              );
              return yield* accepted(job);
            }).pipe(Effect.catch(fail(400))),
          ),
        );

      const jobList = HttpRouter.add(
        "GET",
        "/api/jobs",
        api(() =>
          Ref.get(jobs).pipe(
            Effect.flatMap((all) => jsonResponse(Schema.Array(UiJob))([...all.values()])),
          ),
        ),
      );

      const alerts = HttpRouter.add(
        "GET",
        "/api/alerts",
        api(() =>
          actions.alerts.pipe(
            Effect.flatMap(jsonResponse(Schema.Array(UiAlert))),
            Effect.catch(fail(500)),
          ),
        ),
      );

      const models = HttpRouter.add(
        "GET",
        "/api/models",
        api(() =>
          current.pipe(
            Effect.flatMap((c) => jsonResponse(UiModels)(toUiModels(c.check))),
            Effect.catch(fail(500)),
          ),
        ),
      );

      const config = HttpRouter.add(
        "GET",
        "/api/config/:node",
        api(() =>
          Effect.gen(function* () {
            const node = (yield* HttpRouter.params)["node"] ?? "";
            if (!NAME.test(node)) return plain("not a machine name", 400);
            return yield* actions
              .config(node)
              .pipe(Effect.flatMap(jsonResponse(Schema.Array(UiConfigRow))));
          }).pipe(Effect.catch(fail(404))),
        ),
      );

      const skills = HttpRouter.add(
        "GET",
        "/api/skills",
        api(() =>
          Effect.all([current, actions.skills.list]).pipe(
            Effect.flatMap(([c, list]) => jsonResponse(UiSkills)(toUiSkills(c.check, list))),
            Effect.catch(fail(500)),
          ),
        ),
      );

      /** A skills POST: decode the body and refuse what `invalid` finds wrong. */
      const skillsRoute = <S extends Schema.Top & { readonly DecodingServices: never }>(
        path: `/api/skills/${string}`,
        schema: S,
        invalid: (request: S["Type"]) => string | null,
        run: (request: S["Type"]) => Effect.Effect<HttpServerResponse.HttpServerResponse, string>,
      ) =>
        HttpRouter.add(
          "POST",
          path,
          api((request) =>
            Effect.gen(function* () {
              const asked = yield* body(schema)(request);
              const why = invalid(asked);
              if (why !== null) return plain(why, 400);
              return yield* run(asked).pipe(Effect.catch(fail(409)));
            }).pipe(Effect.catch(fail(400))),
          ),
        );

      /**
       * A look at the repo the request waits for. It runs to the end even if
       * the tab goes away: a preview changes the repo and puts it back.
       */
      const readRepo = <S extends Schema.Top & { readonly EncodingServices: never }>(
        schema: S,
        run: Effect.Effect<S["Type"], string>,
      ) =>
        editingRepo
          .withPermits(1)(run)
          .pipe(Effect.uninterruptible, Effect.flatMap(jsonResponse(schema)));

      /** A change to the repo, as a job. */
      const changeRepo = (
        kind: UiJobKind,
        title: string,
        run: Effect.Effect<UiSkillsLanded, string>,
      ) =>
        startJob(kind, title, editingRepo, (step) =>
          step("changing the config repo").pipe(
            Effect.andThen(run),
            Effect.map((landed) => ({ landed })),
          ),
        ).pipe(Effect.flatMap(accepted));

      const badNames = (names: ReadonlyArray<string>) => {
        const bad = names.find((n) => !NAME.test(n));
        return bad === undefined ? null : `not a skill name: ${bad}`;
      };
      const badSource = (source: string) =>
        SKILL_SOURCE.test(source) ? null : "give owner/repo, or an https or ssh git URL";
      const names = (skills: ReadonlyArray<string>) =>
        skills.length === 0 ? "every skill with a source" : skills.join(", ");

      const skillsLookup = skillsRoute(
        "/api/skills/lookup",
        UiSkillsLookupRequest,
        (r) => badSource(r.source),
        (r) => readRepo(UiSkillsLookup, actions.skills.lookup(r.source)),
      );
      const skillsAdd = skillsRoute(
        "/api/skills/add",
        UiSkillsAddRequest,
        (r) => badSource(r.source) ?? badNames(r.as === undefined ? r.skills : [...r.skills, r.as]),
        (r) =>
          changeRepo(
            "skills-add",
            `Add ${r.as ?? names(r.skills)} from ${r.source}`,
            actions.skills.add(r.source, r.skills, r.as),
          ),
      );
      const skillsPreview = skillsRoute(
        "/api/skills/preview",
        UiSkillsNames,
        (r) => badNames(r.skills),
        (r) => readRepo(UiSkillsPreview, actions.skills.preview(r.skills)),
      );
      const skillsUpdate = skillsRoute(
        "/api/skills/update",
        UiSkillsKeepRequest,
        (r) => badNames(r.skills),
        (r) =>
          changeRepo(
            "skills-update",
            `Update ${names(r.skills)}`,
            actions.skills.update(r.skills, r.digest),
          ),
      );
      const skillsRemove = skillsRoute(
        "/api/skills/remove",
        UiSkillsNames,
        (r) => (r.skills.length === 0 ? "name the skills to remove" : badNames(r.skills)),
        (r) =>
          changeRepo("skills-remove", `Remove ${names(r.skills)}`, actions.skills.remove(r.skills)),
      );

      /** Forward to the relay's hub, with the relay token, and check the answer's shape. */
      const hub = <
        S extends Schema.Top & {
          readonly DecodingServices: never;
          readonly EncodingServices: never;
        },
      >(
        method: "GET" | "POST",
        path: string,
        schema: S | null,
      ) =>
        Effect.gen(function* () {
          const relay = yield* relayNow;
          if (relay === null) return plain("this fleet has no relay, so no hub", 503);
          const response = yield* client
            .execute(
              HttpClientRequest.make(method)(`${relay.url}${path}`).pipe(
                HttpClientRequest.bearerToken(relay.token),
              ),
            )
            .pipe(Effect.timeout(Duration.seconds(15)), Effect.option);
          if (Option.isNone(response)) return plain("the relay did not answer", 502);
          const r = response.value;
          if (r.status === 404) return plain("the relay has no hub", 404);
          if (r.status < 200 || r.status >= 300) {
            const text = yield* r.text.pipe(Effect.orElseSucceed(() => ""));
            return plain(text.trim() || `the relay answered ${r.status}`, 502);
          }
          if (schema === null)
            return HttpServerResponse.empty({ status: 204, headers: SECURITY_HEADERS });
          const text = yield* r.text.pipe(Effect.orElseSucceed(() => ""));
          const value = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
            Effect.option,
          );
          if (Option.isNone(value)) return plain("the relay's answer was not understood", 502);
          return yield* jsonResponse(schema)(value.value);
        });

      const hubServers = HttpRouter.add(
        "GET",
        "/api/hub/servers",
        api(() => hub("GET", "/hub/servers", Schema.Array(HubServer))),
      );

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

      const frame = (type: string, data: string, id?: number) =>
        `${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${data}\n\n`;

      /**
       * Live updates. A tab that connects (or reconnects) first gets where
       * things stand: the latest status, the last failed check if it is newer,
       * and every job; then each event as it happens.
       */
      const eventStream = HttpRouter.add(
        "GET",
        "/api/events",
        api(
          () => {
            const stream = Stream.unwrap(
              Effect.gen(function* () {
                // Subscribed before the snapshot is taken, so nothing falls between them.
                const subscription = yield* PubSub.subscribe(events);
                yield* Ref.update(clients, (n) => n + 1);
                yield* Effect.addFinalizer(() => Ref.update(clients, (n) => n - 1));
                yield* whenInFleet(checked(everyMs)).pipe(Effect.forkIn(scope));
                const snapshot: Array<string> = [": connected\n\n"];
                const kept = yield* Ref.get(latest);
                if (kept !== null)
                  snapshot.push(
                    frame(
                      "check",
                      yield* encodeStatus(kept.status).pipe(Effect.orElseSucceed(() => "null")),
                    ),
                  );
                const failed = yield* Ref.get(lastError);
                if (failed !== null && (kept === null || failed.at > kept.status.checkedAt)) {
                  snapshot.push(
                    frame(
                      "check-failed",
                      yield* encodeFailed(failed).pipe(Effect.orElseSucceed(() => "null")),
                    ),
                  );
                }
                for (const job of (yield* Ref.get(jobs)).values()) {
                  snapshot.push(
                    frame("job", yield* encodeJob(job).pipe(Effect.orElseSucceed(() => "null"))),
                  );
                }
                const keepalive = Stream.tick(Duration.seconds(25)).pipe(
                  Stream.map(() => ": keepalive\n\n"),
                );
                return Stream.fromIterable(snapshot).pipe(
                  Stream.concat(
                    Stream.merge(
                      Stream.fromSubscription(subscription).pipe(
                        Stream.map((e) => frame(e.type, e.data, e.id)),
                      ),
                      keepalive,
                    ),
                  ),
                );
              }),
            );
            return Effect.succeed(
              HttpServerResponse.stream(stream.pipe(Stream.encodeText), {
                contentType: "text/event-stream",
                headers: {
                  ...SECURITY_HEADERS,
                  "cache-control": "no-cache",
                  connection: "keep-alive",
                },
              }),
            );
          },
          { queryToken: true },
        ),
      );

      // ── the setup wizard ──

      /** One setup at a time: deciding to start one, and its jobs, until the last ends. */
      const startingSetup = yield* Semaphore.make(1);
      const settingUp = yield* Semaphore.make(1);
      const encodeSession = Schema.encodeEffect(Schema.fromJsonString(UiSession));
      const setupRunning = Ref.get(jobs).pipe(
        Effect.map((all) =>
          [...all.values()].some(
            (j) => (j.kind === "setup" || j.kind === "setup-hub") && j.finishedAt === null,
          ),
        ),
      );

      /** Start each job once the one before it has succeeded; the first one's id. */
      const chain = (setupJobs: ReadonlyArray<SetupJob>): Effect.Effect<string | null> => {
        const [first, ...rest] = setupJobs;
        if (first === undefined) return Effect.succeed(null);
        return startJob(first.kind, first.title, settingUp, (step) =>
          first.run(step).pipe(
            // Set up now: the app reloads into the fleet's views on this.
            Effect.tap(() =>
              first.kind !== "setup"
                ? Effect.void
                : sessionNow.pipe(
                    Effect.flatMap(encodeSession),
                    Effect.flatMap((data) => publish("session", data)),
                    Effect.ignore,
                  ),
            ),
            Effect.tap(() => chain(rest)),
            Effect.as({}),
          ),
        ).pipe(Effect.map((job) => job.id));
      };

      /** An ssh destination as ssh takes it: never an option, never more than one word. */
      const SSH_DESTINATION = /^(?!-)[A-Za-z0-9_.@:[\]%-]+$/;

      const setupRoute = <S extends Schema.Top & { readonly DecodingServices: never }>(
        path: `/api/setup/${string}`,
        schema: S,
        run: (
          setup: SetupActions,
          request: S["Type"],
        ) => Effect.Effect<HttpServerResponse.HttpServerResponse, string>,
      ) =>
        HttpRouter.add(
          "POST",
          path,
          api((request) =>
            Effect.gen(function* () {
              if (options.setup === undefined) return plain("no setup here", 404);
              const asked = yield* body(schema)(request);
              return yield* run(options.setup, asked).pipe(Effect.catch(fail(409)));
            }).pipe(Effect.catch(fail(400))),
          ),
        );

      const setupState = HttpRouter.add(
        "GET",
        "/api/setup/state",
        api(() =>
          options.setup === undefined
            ? Effect.succeed(plain("no setup here", 404))
            : options.setup.state.pipe(
                Effect.flatMap(jsonResponse(UiSetupState)),
                Effect.catch(fail(500)),
              ),
        ),
      );

      const setupProbe = setupRoute("/api/setup/probe", UiProbeRequest, (setup, r) =>
        SSH_DESTINATION.test(r.ssh)
          ? setup.probe(r.ssh).pipe(Effect.flatMap(jsonResponse(UiProbe)))
          : Effect.succeed(plain("not an ssh destination: host, or user@host", 400)),
      );

      const setupPlan = setupRoute("/api/setup/plan", UiSetupPlanRequest, (setup, r) =>
        r.hub !== null && !SSH_DESTINATION.test(r.hub.ssh)
          ? Effect.succeed(plain("not an ssh destination: host, or user@host", 400))
          : setup.plan(r).pipe(Effect.flatMap(jsonResponse(UiSetupPlan))),
      );

      const setupApply = setupRoute("/api/setup/apply", UiSetupApplyRequest, (setup, r) =>
        startingSetup.withPermits(1)(
          Effect.gen(function* () {
            if (yield* setupRunning)
              return yield* Effect.fail("setup is running already; watch its job");
            const jobId = yield* chain(yield* setup.apply(r));
            return yield* jsonResponse(UiSetupStarted, jobId === null ? 200 : 202)({ jobId });
          }),
        ),
      );

      const setupInvite = setupRoute("/api/setup/invite", UiInviteRequest, (setup, r) =>
        editingRepo
          .withPermits(1)(setup.invite(r.node))
          .pipe(Effect.flatMap(jsonResponse(UiInvite))),
      );

      const unknownApi = HttpRouter.add(
        "*",
        "/api/*",
        api(() => Effect.succeed(plain("no such endpoint", 404))),
      );

      // The app. Any path without an asset gets index.html, so views have real URLs.
      const app = HttpRouter.add(
        "GET",
        "/*",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const who = yield* identity(request);
          if ("refused" in who)
            return HttpServerResponse.text(refusedPage(who.refused), {
              status: who.refused.status,
              contentType: "text/html; charset=utf-8",
              headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
            });
          const refused =
            options.hub === undefined
              ? refusal(request, { port: options.port, tokens: null }, new URLSearchParams())
              : null;
          if (refused !== null) return plain(refused.message, refused.status);
          const path = new URL(request.url, "http://ui").pathname;
          const asset = options.assets.get(path);
          const served =
            asset ?? (/\.[a-z0-9]+$/i.test(path) ? undefined : options.assets.get("/index.html"));
          if (served === undefined) {
            return plain(
              options.assets.size === 0
                ? "this build of T3 Fleet has no UI; build it with `pnpm --filter t3-fleet build`"
                : "not found",
              404,
            );
          }
          // Nothing is cached: a loopback port can be someone else's between runs, and a
          // cached script from then must not run in this one.
          return HttpServerResponse.uint8Array(served.body, {
            contentType: served.type,
            headers: { ...SECURITY_HEADERS, "cache-control": "no-store" },
          });
        }),
      );

      return Layer.mergeAll(
        trade,
        session,
        status,
        fixPlan,
        fixes,
        proposals,
        decide("approve"),
        decide("reject"),
        jobList,
        alerts,
        models,
        config,
        skills,
        skillsLookup,
        skillsAdd,
        skillsPreview,
        skillsUpdate,
        skillsRemove,
        hubServers,
        hubCalls,
        hubAction("login"),
        hubAction("logout"),
        hubAction("restart"),
        setupState,
        setupProbe,
        setupPlan,
        setupApply,
        setupInvite,
        eventStream,
        unknownApi,
        app,
      );
    }),
  );
