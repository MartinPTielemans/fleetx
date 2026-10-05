/**
 * Fixes asked for in the app on the hub, run by the machine they change.
 *
 * The hub has no ssh to the other machines and must not need any. When
 * someone applies a fix there, the hub hands the relay a request naming each
 * finding by id, with the digest of its fix as it was shown (Fix.ts
 * fixDigest). The relay announces it as a "fix" event carrying only the node
 * and the request's id; that node's `t3-fleet listen` (for the relay node,
 * `t3-fleet relay serve` itself) claims it, checks itself again, and runs a
 * fix only if its own check proposes it, to run here, with the digest that was
 * reviewed, and with what it interrupts acknowledged. That is the rule the
 * local app and fleet_apply_fixes follow: nothing runs that T3 Fleet on that
 * machine did not propose. Anything else is refused with the reason. Progress
 * and the result go back to the relay, with the node's secret values taken out
 * of every output.
 *
 * A request is claimed once, atomically: the first "running" moves it from
 * waiting and names a claim, a token only that run knows, and every later
 * report must carry the same claim. A second listener, a replayed event, or a
 * run that read the request before another claimed it is refused, so a fix
 * never runs twice for one request. One nobody claimed within the pickup time
 * is expired by the hub, so a machine that wakes later never runs a fix
 * someone gave up waiting for.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { UiApplyResult } from "./Api.ts";
import type { Finding, Fix } from "./Diagnose.ts";
import { fixDigest, type FixOutcome } from "./Fix.ts";
import { findingId } from "./Memory.ts";
import { redactSecrets } from "./RelayClient.ts";

export const ForwardedFix = Schema.Struct({ id: Schema.String, digest: Schema.String });

/** What the hub asks the relay for: fixes on one machine. */
export const FixRequestBody = Schema.Struct({
  node: Schema.String,
  fixes: Schema.Array(ForwardedFix),
  /** Ids whose interruption the person confirmed. */
  acknowledged: Schema.Array(Schema.String),
});
export type FixRequestBody = typeof FixRequestBody.Type;

export const FixRequestState = Schema.Literals(["waiting", "running", "done", "failed", "expired"]);

export const FixRequestRecord = Schema.Struct({
  id: Schema.String,
  node: Schema.String,
  at: Schema.Number,
  fixes: Schema.Array(ForwardedFix),
  acknowledged: Schema.Array(Schema.String),
  state: FixRequestState,
  step: Schema.NullOr(Schema.String),
  result: Schema.NullOr(UiApplyResult),
  error: Schema.NullOr(Schema.String),
  /** The claim of the run answering it; kept by the relay, never handed out (publicRecord). */
  claim: Schema.optionalKey(Schema.String),
});
export type FixRequestRecord = typeof FixRequestRecord.Type;

/** A request as the relay hands it out: without its claim. */
export const publicRecord = (record: FixRequestRecord): FixRequestRecord => {
  const { claim: _claim, ...rest } = record;
  return rest;
};

/**
 * What the machine reports back. The first "running" claims the request with
 * `claim`, a token of its own; every report after it carries the same one.
 */
export const FixProgress = Schema.Struct({
  state: Schema.Literals(["running", "done", "failed"]),
  step: Schema.NullOr(Schema.String),
  result: Schema.NullOr(UiApplyResult),
  error: Schema.NullOr(Schema.String),
  claim: Schema.String,
});
export type FixProgress = typeof FixProgress.Type;

/** A claim no one else can guess. */
export const newClaim = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** The "fix" event's data. */
export const FixAnnouncement = Schema.Struct({ node: Schema.String, request: Schema.String });

/** A request after `progress`, or why the relay refuses it (a second claim, a late answer). */
export const advance = (
  record: FixRequestRecord,
  progress: FixProgress,
): FixRequestRecord | string => {
  if (progress.claim.length < 16) return "a report names its claim";
  if (record.state === "waiting") {
    if (progress.state !== "running") return "claim the request (running) before answering it";
  } else if (record.state !== "running") return `this request is ${record.state}`;
  else if (record.claim !== progress.claim) return "this request is claimed by another run";
  return {
    ...record,
    state: progress.state,
    step: progress.step,
    result: progress.result,
    error: progress.error,
    claim: progress.claim,
  };
};

type Fixable = Finding & { readonly fix: Fix };

/**
 * Which of a request's fixes this machine runs: those its own check proposes,
 * to run here, exactly as reviewed, with what they interrupt acknowledged.
 */
export const chooseForwarded = (
  self: string,
  findings: ReadonlyArray<Finding>,
  request: Pick<FixRequestBody, "fixes" | "acknowledged">,
) =>
  Effect.gen(function* () {
    const byId = new Map(findings.map((f) => [findingId(f), f]));
    const chosen: Array<Fixable> = [];
    const notApplied: Array<{ id: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const asked of request.fixes) {
      if (seen.has(asked.id)) continue;
      seen.add(asked.id);
      const finding = byId.get(asked.id);
      if (finding === undefined)
        notApplied.push({
          id: asked.id,
          reason: `${self} does not find this now; it may already be fixed`,
        });
      else if (finding.fix === undefined)
        notApplied.push({ id: asked.id, reason: `${self} proposes no fix for this` });
      else if ((finding.fix.on ?? finding.node) !== self)
        notApplied.push({
          id: asked.id,
          reason: `this fix runs on ${finding.fix.on ?? finding.node}, not ${self}`,
        });
      else if ((yield* fixDigest(finding as Fixable)) !== asked.digest)
        notApplied.push({
          id: asked.id,
          reason: `${self} would run a different fix now; review it again`,
        });
      else if (finding.fix.disrupts !== undefined && !request.acknowledged.includes(asked.id))
        notApplied.push({
          id: asked.id,
          reason: `interrupts ${finding.fix.disrupts}, and that was not confirmed`,
        });
      else chosen.push(finding as Fixable);
    }
    return { chosen, notApplied };
  });

/**
 * Answer one request on the machine it names: claim it, check again, run what
 * may run, report. A request for another machine, or one already claimed, is
 * left alone. Nothing runs unless this run's claim is the one the relay took.
 */
export const answerFixRequest = <R, R2, R3>(options: {
  readonly self: string;
  readonly request: FixRequestRecord;
  /** False when the relay refuses it: claimed by someone else, or expired. */
  readonly progress: (progress: FixProgress) => Effect.Effect<boolean, never, R3>;
  /** This machine's own findings, from a check made now. */
  readonly findings: Effect.Effect<ReadonlyArray<Finding>, string, R>;
  /** Runs the fixes, their outputs cleared of `secrets` before anything is cut from them (Fix.runFix). */
  readonly run: (
    fixes: ReadonlyArray<Fixable>,
    secrets: ReadonlyMap<string, string>,
  ) => Effect.Effect<ReadonlyArray<FixOutcome>, never, R2>;
  readonly secrets: ReadonlyMap<string, string>;
  /** Once this run holds the claim: a request expired or taken by another is never announced. */
  readonly claimed?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { self, request } = options;
    if (request.node !== self || request.state !== "waiting") return false;
    const claim = newClaim();
    const progress = (p: Omit<FixProgress, "claim">) => options.progress({ ...p, claim });
    const running = (step: string) =>
      progress({ state: "running", step, result: null, error: null });
    if (!(yield* running(`${self} is checking itself again`))) return false;
    if (options.claimed !== undefined) yield* options.claimed;
    const found = yield* options.findings.pipe(Effect.result);
    if (found._tag === "Failure") {
      yield* progress({
        state: "failed",
        step: null,
        result: null,
        error: redactSecrets(`${self} could not check itself: ${found.failure}`, options.secrets),
      });
      return true;
    }
    const { chosen, notApplied } = yield* chooseForwarded(self, found.success, request);
    let outcomes: ReadonlyArray<FixOutcome> = [];
    if (chosen.length > 0) {
      yield* running(
        `${self} is running ${chosen.length === 1 ? "1 fix" : `${chosen.length} fixes`}`,
      );
      outcomes = yield* options.run(chosen, options.secrets);
    }
    yield* progress({
      state: "done",
      step: null,
      error: null,
      result: {
        results: outcomes.map((o) => ({
          id: findingId(o.finding),
          node: o.finding.node,
          title: o.finding.title,
          ok: o.ok,
          output: redactSecrets(o.summary, options.secrets),
        })),
        notApplied,
      },
    });
    return true;
  });

// ── the hub's side ──────────────────────────────────────────────────────

/** The relay's store of requests, as the hub reaches it. */
export interface FixRelay {
  readonly request: (body: FixRequestBody) => Effect.Effect<FixRequestRecord>;
  readonly get: (id: string) => Effect.Effect<FixRequestRecord | null>;
  /** Expire a request nobody claimed; false when it was claimed meanwhile (or is gone). */
  readonly expire: (id: string) => Effect.Effect<boolean>;
}

/** How long a machine has to pick a request up, and to finish it. */
export interface ForwardTimes {
  readonly pickup?: Duration.Input;
  readonly limit?: Duration.Input;
  readonly poll?: Duration.Input;
}

/**
 * Send each machine its fixes through the relay and wait for the answers:
 * `fix.on ?? node` is the machine that runs a fix, so that is where it goes.
 * Every fix asked for comes back as an outcome; one that was not run says why.
 */
export const forwardFixes = (
  relay: FixRelay,
  fixes: ReadonlyArray<Fixable>,
  step: (text: string) => Effect.Effect<void>,
  times: ForwardTimes = {},
) =>
  Effect.gen(function* () {
    const pickupMs = Duration.toMillis(Duration.fromInputUnsafe(times.pickup ?? "90 seconds"));
    const limitMs = Duration.toMillis(Duration.fromInputUnsafe(times.limit ?? "30 minutes"));
    const poll = times.poll ?? "1 second";
    const byTarget = new Map<string, Array<Fixable>>();
    for (const f of fixes) {
      const target = f.fix.on ?? f.node;
      byTarget.set(target, [...(byTarget.get(target) ?? []), f]);
    }
    const perTarget = yield* Effect.forEach(
      [...byTarget],
      ([target, mine]) =>
        Effect.gen(function* () {
          const failAll = (summary: string) =>
            mine.map((finding): FixOutcome => ({ finding, ok: false, summary }));
          const asked = yield* Effect.forEach(mine, (f) =>
            fixDigest(f).pipe(Effect.map((digest) => ({ id: findingId(f), digest }))),
          );
          const record = yield* relay.request({
            node: target,
            fixes: asked,
            acknowledged: mine.filter((f) => f.fix.disrupts !== undefined).map(findingId),
          });
          yield* step(`sent to ${target}; waiting for it to pick the fixes up`);
          const started = yield* Clock.currentTimeMillis;
          let lastStep: string | null = null;
          while (true) {
            yield* Effect.sleep(poll);
            const now = yield* Clock.currentTimeMillis;
            const current = yield* relay.get(record.id);
            if (current === null) return failAll(`the relay lost the request to ${target}`);
            if (current.state === "waiting" && now - started > pickupMs) {
              if (yield* relay.expire(record.id))
                return failAll(
                  `${target} did not pick this up: it is asleep, or its \`t3-fleet listen\` is not running or predates fixes from the hub. Nothing was run.`,
                );
              continue;
            }
            if (current.state === "running" && current.step !== null && current.step !== lastStep) {
              lastStep = current.step;
              yield* step(current.step);
            }
            if (current.state === "failed")
              return failAll(current.error ?? `${target} could not run the fixes`);
            if (current.state === "expired") return failAll(`the request to ${target} expired`);
            if (current.state === "done") {
              const result = current.result ?? { results: [], notApplied: [] };
              return mine.map((finding): FixOutcome => {
                const id = findingId(finding);
                const ran = result.results.find((r) => r.id === id);
                if (ran !== undefined) return { finding, ok: ran.ok, summary: ran.output };
                const why = result.notApplied.find((n) => n.id === id)?.reason;
                return {
                  finding,
                  ok: false,
                  summary: `not run: ${why ?? `${target} did not say`}`,
                };
              });
            }
            if (now - started > limitMs)
              return failAll(
                `no answer from ${target} within ${Math.round(limitMs / 60000)} minutes; its next report shows whether the fixes took`,
              );
          }
        }),
      { concurrency: "unbounded" },
    );
    return perTarget.flat();
  });

// ── a machine's side, over HTTP ─────────────────────────────────────────

const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(FixRequestRecord));
const encodeProgress = Schema.encodeEffect(Schema.fromJsonString(FixProgress));

/** The request with this id, from the relay at `url`; null when it has none or does not answer. */
export const fetchFixRequest = (url: string, token: string, id: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const text = yield* client
      .execute(
        HttpClientRequest.get(`${url}/fixes/${encodeURIComponent(id)}`).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(
        Effect.flatMap((r) => (r.status === 200 ? r.text.pipe(Effect.asSome) : Effect.succeedNone)),
        Effect.timeout(Duration.seconds(10)),
        Effect.orElseSucceed(() => Option.none<string>()),
      );
    if (Option.isNone(text)) return null;
    return yield* decodeRecord(text.value).pipe(Effect.orElseSucceed(() => null));
  });

/** Report progress; false when the relay refuses it (claimed by someone else, or expired). */
export const sendFixProgress = (url: string, token: string, id: string, progress: FixProgress) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const body = yield* encodeProgress(progress);
    const response = yield* client.execute(
      HttpClientRequest.post(`${url}/fixes/${encodeURIComponent(id)}/progress`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );
    return response.status === 204;
  }).pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.orElseSucceed(() => false),
  );
