/**
 * The setup wizard's answers (SetupApi.ts), from the same engine as
 * `t3-fleet setup` (Session.ts). UiServer.ts serves them; `t3-fleet ui` wires
 * them up with what only the command can do (connecting T3).
 *
 * A plan is applied only while nothing it read has changed: its id is a
 * digest of what it read and decided (the mode, this machine's discovery, the
 * fleet, the plan), keyed with a secret only this server knows, so the id says
 * nothing about secret values. Apply reads everything again and refuses a
 * plan whose digest no longer matches; the app plans again.
 *
 * Values typed in the browser go exactly where `t3-fleet setup` puts the ones
 * typed in a terminal: into the run, whose values are encrypted to this
 * machine's key before its first step (State.ts). They never reach a job's
 * step: steps say what was done, as the terminal does.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { ProbeServices } from "../Area.ts";
import { loadConfig, type Config } from "../Config.ts";
import { exec } from "../Exec.ts";
import { git, out } from "../Git.ts";
import { sha256 } from "../Hash.ts";
import { testNotification } from "../Notify.ts";
import { addNode, inviteLine } from "../Init.ts";
import type {
  UiInvite,
  UiNotifyTest,
  UiPlanConflict,
  UiPlanItem,
  UiProbe,
  UiSetupApplyRequest,
  UiSetupPlan,
  UiSetupPlanRequest,
  UiSetupState,
} from "../SetupApi.ts";
import { NTFY_SECRET, isNtfyUrl } from "../Upkeep.ts";
import { settingsLines, upkeepFor, type Extras, type SetupInput, type Upkeep } from "./Apply.ts";
import type { Secret } from "./Credentials.ts";
import { cleanUrl, nodeName, tilde } from "./Discover.ts";
import {
  applies,
  detailOf,
  type Choice,
  type FleetView,
  type Plan,
  type PlanServer,
} from "./Plan.ts";
import { preflight, type Preflight } from "./Preflight.ts";
import {
  bringUp,
  dropHub,
  otherRelay,
  readHub,
  requireAuthority,
  undoAdmission,
  updateHub,
  writeHub,
  type HubRequest,
} from "./Hub.ts";
import { hostingPlan } from "./HubHosting.ts";
import { hubStepTitles, mcpHubLine } from "./PlanWords.ts";
import { pinOwnBundle, probeHub } from "./Remote.ts";
import { remoteGitEnv, SELF_SERVER } from "./Repo.ts";
import {
  abandonRun,
  decideRun,
  finishAbandoned,
  finishedLines,
  leavingRefusal,
  NODE_NAME,
  prepare,
  resumeInput,
  RUN_ELSEWHERE,
  runLockPath,
  runningElsewhere,
  runSteps,
  savedSteps,
  startRun,
  stepTitles,
  unfinishedRun,
  withRunLock,
  type Prepared,
  type PrepareRequest,
} from "./Session.ts";
import { clearAbandoned } from "./State.ts";
import { waitForSyncLock, withMachineLock } from "../SyncLock.ts";

/** A job apply starts: the local setup, then the hub. */
export interface SetupJob {
  readonly kind: "setup" | "setup-hub";
  readonly title: string;
  readonly run: (step: (text: string) => Effect.Effect<void>) => Effect.Effect<void, string>;
}

/** Apply refused a plan that is out of date: something it read changed, or its id is too old. */
export class StalePlan extends Schema.TaggedError<StalePlan>()("StalePlan", {
  message: Schema.String,
}) {}

/** Another T3 Fleet process here is applying a setup now (Session.withRunLock): wait for it. */
export class RunningElsewhere extends Schema.TaggedError<RunningElsewhere>()(
  "RunningElsewhere",
  {},
) {
  override get message() {
    return RUN_ELSEWHERE;
  }
}

/** What the server asks of the wizard's engine; Wizard.make gives the real one, tests fakes. */
export interface SetupActions {
  readonly state: Effect.Effect<UiSetupState, string>;
  /** `repo`: the repository the fleet will be in, when the wizard knows it (UiProbeRequest). */
  readonly probe: (ssh: string, repo?: string) => Effect.Effect<UiProbe>;
  readonly plan: (request: UiSetupPlanRequest) => Effect.Effect<UiSetupPlan, string>;
  /** The jobs to run, in order; refused with why, a stale plan as StalePlan, a run locked by another process as RunningElsewhere. */
  readonly apply: (
    request: Exclude<UiSetupApplyRequest, { readonly kind: "abandon" }>,
  ) => Effect.Effect<ReadonlyArray<SetupJob>, string | StalePlan | RunningElsewhere>;
  /**
   * Drop the stopped run and any hub still to bring up, taking out what the
   * hub's admission committed; what the run had done, a line each.
   */
  readonly abandon: Effect.Effect<ReadonlyArray<string>, string | RunningElsewhere>;
  readonly invite: (node: string) => Effect.Effect<UiInvite, string>;
  /** Once set up: one test alert through this machine's [notify] paths, as `t3-fleet notify test`. */
  readonly notifyTest: Effect.Effect<UiNotifyTest, string>;
}

/** Claude's long-lived token, which the model proxy uses: asked for like a missing credential. */
export const MODEL_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

const message = (e: unknown) =>
  typeof e === "string"
    ? e
    : typeof e === "object" && e !== null && "message" in e
      ? String(e.message)
      : String(e);

const clientName = (client: "claude" | "codex") => (client === "claude" ? "Claude Code" : "Codex");

/** The server a secret was found in, by its name. */
const serverOf = (plan: Plan, name: string): PlanServer | undefined =>
  [
    ...plan.add.servers,
    ...plan.same.servers,
    ...plan.conflicts.flatMap((c) => (c.kind === "server" ? c.options : [])),
  ].find((s) => s.found.extracted.secrets.some((x) => x.name === name));

const serverItem = (s: PlanServer): UiPlanItem => ({
  kind: "server",
  name: s.name,
  from: clientName(s.found.client),
  note:
    s.scope === "machine"
      ? `on this machine only: ${s.why ?? ""}`
      : s.scope === "declared"
        ? `declared, registered nowhere: ${s.why ?? ""}`
        : null,
});

/**
 * The conflicts as the plan screen asks them. One that follows another gets
 * `byChoice`: for each of that one's choices, its diff then, or null when
 * that choice settles it (as the terminal skips it, Plan.applies).
 */
export const uiConflicts = (plan: Plan, fleet: FleetView): Array<UiPlanConflict> =>
  plan.conflicts.map((c) => {
    const first = c.after === undefined ? undefined : plan.conflicts.find((x) => x.id === c.after);
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      title: c.title,
      detail: detailOf(c, {}, fleet),
      choices: c.choices.map((x) => ({ value: x.value, label: x.label })),
      default: c.default,
      after: c.after ?? null,
      ...(first === undefined
        ? {}
        : {
            byChoice: Object.fromEntries(
              first.choices.map((x) => {
                const picked = { [first.id]: x.value };
                return [
                  x.value,
                  applies(c, picked, plan.conflicts) ? detailOf(c, picked, fleet) : null,
                ];
              }),
            ),
          }),
    };
  });

/** The plan as the plan screen shows it. */
export const toUiPlan = (
  p: Prepared,
  input: SetupInput,
  extra: {
    readonly planId: string;
    readonly missing: ReadonlyArray<{ readonly name: string; readonly why: string }>;
    readonly hub: HubRequest | null;
    readonly remote: string | null;
  },
): UiSetupPlan => {
  const t = (path: string) => tilde(path, p.home);
  const { plan } = p;
  const skillItem = (s: Plan["add"]["skills"][number]): UiPlanItem => ({
    kind: "skill",
    name: s.name,
    from: s.copy.root,
    note:
      s.copy.source === null ? null : `${s.copy.source.url} @ ${s.copy.source.commit.slice(0, 7)}`,
  });
  const instructionItem = (i: Plan["add"]["instructions"][number]): UiPlanItem => ({
    kind: "instruction",
    name: i.dest,
    from: t(i.at),
    note: `kept as ${i.src}`,
  });
  const self =
    input.actions.servers.some((s) => s.name === SELF_SERVER.name) &&
    !plan.add.servers.some((s) => s.name === SELF_SERVER.name)
      ? [
          {
            kind: "server",
            name: SELF_SERVER.name,
            from: "T3 Fleet",
            note: "T3 Fleet's own, for agents in T3",
          } satisfies UiPlanItem,
        ]
      : [];
  return {
    planId: extra.planId,
    mode: p.mode,
    node: p.node,
    commits: plan.commits,
    repo: { path: t(p.checkout), remote: extra.remote },
    add: [
      ...plan.add.skills.map(skillItem),
      ...plan.add.servers.map(serverItem),
      ...self,
      ...plan.add.instructions.map(instructionItem),
    ],
    same: [
      ...plan.same.skills.map(skillItem),
      ...plan.same.servers.map(serverItem),
      ...plan.same.instructions.map(instructionItem),
    ],
    conflicts: uiConflicts(plan, p.fleet),
    leftAlone: [
      ...plan.ignored.map((i) => ({
        item: { kind: "server" as const, name: i.name, from: "", note: null },
        why: i.why,
      })),
      ...plan.leftAlone.map((l) => ({
        item: l.what.startsWith("skill ")
          ? { kind: "skill" as const, name: l.what.slice("skill ".length), from: "", note: null }
          : { kind: "server" as const, name: l.what, from: "", note: null },
        why: l.why,
      })),
    ],
    secrets: [
      ...plan.secrets.map((s) => {
        const server = serverOf(plan, s.name);
        return {
          name: s.name,
          server: server?.name ?? "",
          from: server === undefined ? s.where : `${clientName(server.found.client)}: ${s.where}`,
        };
      }),
      ...(input.upkeep?.ntfy == null
        ? []
        : [{ name: NTFY_SECRET, server: "notifications", from: "the ntfy topic setup made" }]),
    ],
    missing: extra.missing,
    hub:
      extra.hub === null
        ? null
        : {
            node: extra.hub.node,
            ssh: extra.hub.ssh,
            relayUrl: extra.hub.relayUrl,
            mcp: extra.hub.mcp === true,
            ...(extra.hub.mcp === true
              ? {
                  servers: hostingPlan(
                    new Map([
                      ...p.fleet.servers,
                      ...input.actions.servers.map((s) => [s.name, s.definition] as const),
                    ]),
                  ),
                }
              : {}),
            steps: hubStepTitles(extra.hub),
          },
    settings: [
      ...(extra.hub?.mcp === true ? [mcpHubLine(extra.hub.node)] : []),
      ...settingsLines(input),
    ],
    steps: [
      ...(p.pending
        ? [`Finish what the setup of ${p.record?.node ?? p.node} dropped earlier left`]
        : []),
      ...(p.nothing ? [] : stepTitles(input)),
    ],
  };
};

/** What a digest of a plan covers: everything it read and decided, never where its scratch clone was. */
export const fingerprint = (
  p: Prepared,
  request: unknown,
  missing: ReadonlyArray<unknown>,
  hub: HubRequest | null = null,
) => {
  const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
    request,
    hub,
    mode: p.mode,
    node: p.node,
    checkout: p.checkout,
    branch: p.branch,
    authority: p.authority,
    url: p.url,
    plan: p.plan,
    preview: p.preview,
    remote: p.remoteTarget,
    offers: p.offers,
    timerNow: p.timerNow,
    nothing: p.nothing,
    pending: p.pending,
    record: p.record?.startedAt ?? null,
    missing,
    fleet: {
      skills: [...p.fleet.skills],
      servers: [...p.fleet.servers],
      declared: p.fleet.declared,
      ignored: p.fleet.ignored,
      instructions: p.fleet.instructions,
      secretNames: p.fleet.secretNames,
    },
  });
  return p.scratch === "" ? json : json.split(p.scratch).join("<scratch>");
};

/** Whether a remote holds no branch yet: an empty repository to push a new fleet to. */
export const isEmptyRemote = (url: string) =>
  Effect.gen(function* () {
    const listed = yield* exec({
      command: "git",
      args: ["ls-remote", "--heads", url],
      timeout: Duration.seconds(30),
      env: yield* remoteGitEnv,
    });
    if (listed.code !== 0)
      return yield* Effect.fail(
        `cannot reach ${cleanUrl(url)}: ${listed.stderr.trim().split("\n").pop() ?? `exit ${listed.code}`}`,
      );
    return listed.stdout.trim() === "";
  });

/** The wizard's request as the engine's: which repo, what extras. */
const engineRequest = (
  request: UiSetupPlanRequest,
  pre: Preflight,
  member: boolean,
  scratch: string,
): Effect.Effect<PrepareRequest, string, ProbeServices> =>
  Effect.gen(function* () {
    const base = {
      name: request.node,
      dir: null,
      asked: { relay: false, models: request.extras.includes("model proxy") },
      scratch,
    };
    // A machine set up already plans against its own fleet, whatever the request names.
    if (member) return { ...base, url: null, remote: "default" as const };
    const repo = request.repo;
    if (repo.kind === "local") return { ...base, url: null, remote: null };
    if (repo.kind === "github") {
      const name = repo.name.trim();
      if (!/^(?:[\w.-]+\/)?[\w.-]+$/.test(name))
        return yield* Effect.fail(`"${name}" is not a repository name: name, or owner/name`);
      if (name.includes("/")) return { ...base, url: null, remote: { github: name } };
      if (pre.github === null)
        return yield* Effect.fail(
          "gh is not signed in, so no repository can be created on GitHub: run `gh auth login`, or give an existing repository's URL",
        );
      return { ...base, url: null, remote: { github: `${pre.github}/${name}` } };
    }
    // An empty repository gets a new fleet; one with branches is a fleet to join.
    return (yield* isEmptyRemote(repo.url))
      ? { ...base, url: null, remote: { url: repo.url } }
      : { ...base, url: repo.url, remote: "default" as const };
  });

/** The extras as the run carries them: the relay is the hub's, never this machine's. */
const extrasOf = (
  p: Prepared,
  request: UiSetupPlanRequest,
  values: Readonly<Record<string, string>>,
): Extras => {
  const offered = (name: string) => p.offers.some(([n]) => n === name);
  const token = values[MODEL_TOKEN] ?? process.env[MODEL_TOKEN] ?? "";
  return {
    relay: null,
    models:
      request.extras.includes("model proxy") && offered("model proxy")
        ? { token: token === "" ? null : token }
        : null,
    t3: request.extras.includes("T3 access") && offered("T3 access"),
  };
};

/** Updates and notifications as the run takes them: [fleet] apply only for a new fleet. */
export const upkeepOf = (mode: Prepared["mode"], request: UiSetupPlanRequest): Upkeep =>
  upkeepFor(mode, {
    autoUpdate: mode === "first" ? request.autoUpdate : null,
    desktop: request.notify.desktop,
    ntfy: request.notify.ntfy,
  });

/** Credentials the run needs that were not found: the servers', and Claude's token for the model proxy. */
const missingOf = (p: Prepared, request: UiSetupPlanRequest) => [
  ...p.plan.missing.map((m) => ({ name: m.name, why: m.why })),
  ...(request.extras.includes("model proxy") &&
  p.offers.some(([n]) => n === "model proxy") &&
  (process.env[MODEL_TOKEN] ?? "") === "" &&
  p.found.agents.some((a) => a.name === "claude" && a.path !== null)
    ? [
        {
          name: MODEL_TOKEN,
          why: "Claude's login through the model proxy: run `claude setup-token` in a terminal and paste the token it prints",
        },
      ]
    : []),
];

const preflightRefusal = (pre: Preflight) => {
  const errors = pre.checks.filter((c) => c.severity === "error");
  return errors.length === 0
    ? null
    : `pre-flight failed: ${errors.map((c) => `${c.title}${c.detail === undefined ? "" : ` (${c.detail})`}`).join("; ")}`;
};

interface Planned {
  readonly request: UiSetupPlanRequest;
}

/** The wizard's engine, with what only the command can do. */
export const make = (hooks: {
  readonly t3Connect: Effect.Effect<string, string, ProbeServices>;
  /** Where scratch clones go; TMPDIR otherwise. */
  readonly scratchDir?: string;
  /** The check of a hub over ssh; Remote.probeHub, unless a test fakes the hub. */
  readonly probeHub?: typeof probeHub;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<ProbeServices>();
    // The build the hub is sent is this one, as it is now (Remote.bundleAt).
    yield* pinOwnBundle;
    const closed = <A, E>(effect: Effect.Effect<A, E, ProbeServices>) =>
      effect.pipe(Effect.provide(services), Effect.mapError(message));
    const key = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const plans = yield* Ref.make<ReadonlyMap<string, Planned>>(new Map());
    const checkHub = hooks.probeHub ?? probeHub;
    const home = () => process.env["HOME"] ?? "";

    const scratchFor = Clock.currentTimeMillis.pipe(
      Effect.map(
        (now) =>
          `${hooks.scratchDir ?? process.env["TMPDIR"] ?? "/tmp"}/t3-fleet-setup-${now}-${globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0}`,
      ),
    );
    const removeScratch = (scratch: string) =>
      exec({ command: "rm", args: ["-rf", scratch], timeout: Duration.seconds(30) }).pipe(
        Effect.ignore,
      );
    const member = loadConfig.pipe(
      Effect.map((c): Config | null => c),
      Effect.orElseSucceed(() => null),
    );

    /** Refuse what must not start a new run now. */
    const mayStart = Effect.gen(function* () {
      const leaving = yield* leavingRefusal(home());
      if (Option.isSome(leaving)) return yield* Effect.fail(leaving.value);
      const unfinished = yield* unfinishedRun(home());
      if (Option.isSome(unfinished))
        return yield* Effect.fail(
          "an earlier setup stopped part-way: continue it (resume) or drop it (abandon) first",
        );
    });

    /** The hub asked for, as a check of it finds it now; refused with why when it cannot be the hub. */
    const hubOf = (
      p: Prepared,
      asked: NonNullable<UiSetupPlanRequest["hub"]>,
      config: Config | null,
    ) =>
      Effect.gen(function* () {
        // The fleet this plan is for: the hub may be in it already, never in another.
        const fleetRepo =
          p.mode === "join" || p.mode === "first"
            ? (p.url ??
              (p.remoteTarget !== null && "url" in p.remoteTarget ? p.remoteTarget.url : null))
            : out(yield* git(p.checkout, ["remote", "get-url", "origin"])) || null;
        const probed = yield* checkHub(asked.ssh, fleetRepo);
        if (!probed.reachable)
          return yield* Effect.fail(`cannot reach ${asked.ssh}: ${probed.error ?? "no answer"}`);
        if (!probed.ready) {
          const lacking = [probed.fleet, probed.node, probed.git, probed.t3, probed.service]
            .filter((i) => i.state === "missing")
            .map((i) => `${i.label}${i.remedy === null ? "" : ` (${i.remedy})`}`);
          return yield* Effect.fail(
            `${asked.ssh} is not ready to be the hub${lacking.length > 0 ? `: ${lacking.join("; ")}` : ""}`,
          );
        }
        if (asked.mcp && probed.relayUrl === null)
          return yield* Effect.fail(
            `${asked.ssh} has no tailnet address for your machines to reach its MCP servers at: set up tailscale there, or leave MCP hosting off`,
          );
        const hub: HubRequest = {
          node: asked.node,
          ssh: asked.ssh,
          relayUrl: probed.relayUrl,
          mcp: asked.mcp,
          ...(probed.app?.state === "warn" ? { hostsApp: false } : {}),
          error: null,
        };
        // A fleet with a relay of its own keeps it: admission would refuse this hub (Hub.otherRelay).
        const taken =
          config === null ? null : otherRelay(config, config.settings.relay?.url ?? null, hub);
        if (taken !== null) return yield* Effect.fail(taken);
        return hub;
      });

    /** Read everything, and plan: what the plan screen shows, and what apply re-reads to compare. */
    const planned = (request: UiSetupPlanRequest, scratch: string) =>
      Effect.gen(function* () {
        if (!NODE_NAME.test(request.node))
          return yield* Effect.fail(
            `"${request.node}" is not a machine name: lowercase letters, digits and dashes`,
          );
        if (request.hub !== null) {
          if (!NODE_NAME.test(request.hub.node))
            return yield* Effect.fail(
              `"${request.hub.node}" is not a machine name: lowercase letters, digits and dashes`,
            );
          if (request.hub.node === request.node)
            return yield* Effect.fail("the hub is another machine: give it its own name");
          if (request.repo.kind === "local")
            return yield* Effect.fail(
              "the hub joins through the fleet's repository: choose a GitHub repository or an existing URL",
            );
        }
        if (request.notify.ntfy !== null && !isNtfyUrl(request.notify.ntfy))
          return yield* Effect.fail(
            "the ntfy topic is not one setup makes: https://ntfy.sh/ and a long random name",
          );
        const pre = yield* preflight;
        const refused = preflightRefusal(pre);
        if (refused !== null) return yield* Effect.fail(refused);
        const config = yield* member;
        const p = yield* prepare(
          yield* engineRequest(request, pre, config !== null, scratch),
          pre,
          () => Effect.void,
        );
        // The hub is set up from an authority (or the machine starting the fleet), never a member.
        if (request.hub !== null && !p.authority)
          return yield* Effect.fail(
            `${p.node} is not an authority, so it cannot set up the fleet's hub: run this on an authority, or have one give ${p.node} the authority role`,
          );
        // The hub as it is now: apply checks it again, so a plan says what bring-up will write.
        const hub = request.hub === null ? null : yield* hubOf(p, request.hub, config);
        const missing = missingOf(p, request);
        const digest = yield* Effect.promise(() =>
          sha256(`${key}\n${fingerprint(p, request, missing, hub)}`),
        );
        return { p, missing, digest, config, hub };
      });

    const state: SetupActions["state"] = closed(
      Effect.gen(function* () {
        const pre = yield* preflight;
        const hostname = (yield* exec({
          command: "hostname",
          timeout: Duration.seconds(5),
        })).stdout.trim();
        const unfinished = yield* unfinishedRun(home());
        const leaving = yield* leavingRefusal(home());
        const config = yield* member;
        const hub = yield* readHub(home());
        const elsewhere = yield* runningElsewhere(home());
        return {
          stage: Option.isSome(unfinished) ? "unfinished" : config !== null ? "member" : "fresh",
          hostname,
          suggestedName: config?.self ?? nodeName(hostname),
          checks: [
            ...pre.checks.map((c) => ({
              key: c.key,
              severity: c.severity,
              title: c.title,
              detail: c.detail ?? null,
            })),
            ...(Option.isSome(leaving)
              ? [
                  {
                    key: "leaving",
                    severity: "error" as const,
                    title: "leaving the fleet",
                    detail: leaving.value,
                  },
                ]
              : []),
          ],
          github: pre.github,
          unfinished: Option.match(unfinished, {
            onNone: () => null,
            onSome: (p) => ({
              startedAt: p.startedAt,
              done: p.done.length,
              total: savedSteps(p).length,
              runningElsewhere: elsewhere,
            }),
          }),
          hub: Option.match(hub, {
            onNone: () => null,
            onSome: (h) => ({ node: h.node, ssh: h.ssh, error: h.error }),
          }),
          // Not while the hub's bring-up is still to finish: the app here offers to try it again.
          // Nor when the hub cannot serve the app (UiProbe.app): it opens here instead.
          fleetUrl:
            config === null ||
            Option.isSome(unfinished) ||
            Option.isSome(hub) ||
            config.settings.ui?.hosted === false
              ? null
              : (config.settings.relay?.url?.replace(/\/+$/, "").concat("/") ?? null),
        } satisfies UiSetupState;
      }),
    );

    const plan: SetupActions["plan"] = (request) =>
      closed(
        Effect.gen(function* () {
          yield* mayStart;
          const scratch = yield* scratchFor;
          const { p, missing, digest, hub } = yield* planned(request, scratch).pipe(
            Effect.ensuring(removeScratch(scratch)),
          );
          const input = decideRun(p, {
            choices: {},
            entered: [],
            extras: extrasOf(p, request, {}),
            upkeep: upkeepOf(p.mode, request),
          });
          const remote =
            p.mode === "join" || p.mode === "first"
              ? p.url !== null
                ? cleanUrl(p.url)
                : p.remoteTarget === null
                  ? null
                  : "github" in p.remoteTarget
                    ? `github.com/${p.remoteTarget.github}`
                    : cleanUrl(p.remoteTarget.url)
              : cleanUrl(out(yield* git(p.checkout, ["remote", "get-url", "origin"]))) || null;
          // The newest plans only: an old id is as good as stale.
          yield* Ref.update(plans, (all) => {
            const next = new Map(all);
            next.set(digest, { request });
            return new Map([...next].slice(-8));
          });
          return toUiPlan(p, input, { planId: digest, missing, hub, remote });
        }),
      );

    /** The local run, as a job: saved first, then each step; then the hub, when one was asked for. */
    const runJob = (
      title: string,
      work: (
        step: (text: string) => Effect.Effect<void>,
      ) => Effect.Effect<void, string, ProbeServices>,
    ): SetupJob => ({
      kind: "setup",
      title,
      run: (step) => closed(withRunLock(home(), work(step))),
    });

    const hubJob = (hub: HubRequest): SetupJob => ({
      kind: "setup-hub",
      title: `Bring up ${hub.node}, the hub`,
      run: (step) =>
        closed(
          withRunLock(
            home(),
            Effect.gen(function* () {
              // What an earlier attempt recorded (what it committed) stays with the request.
              const saved = Option.getOrElse(yield* readHub(home()), () => hub);
              yield* writeHub(home(), { ...saved, error: null });
              yield* bringUp(saved, step, home()).pipe(
                Effect.tapError((why) =>
                  updateHub(home(), (h) => ({ ...h, error: why })).pipe(Effect.ignore),
                ),
              );
              yield* dropHub(home());
            }),
          ),
        ),
    });

    const stepsOf = (
      input: SetupInput,
      raw: Prepared["found"]["raw"],
      progress: Parameters<typeof runSteps>[2],
      step: (text: string) => Effect.Effect<void>,
    ) =>
      runSteps(input, { t3Connect: hooks.t3Connect, raw }, progress, {
        started: (s) => step(s.title),
        done: (s, lines) => step(`✓ ${s.title}${lines.length > 0 ? `: ${lines.join("; ")}` : ""}`),
        failed: () => Effect.void,
        note: step,
      }).pipe(
        Effect.mapError(
          (stopped) =>
            `setup stopped at "${stopped.step}": ${stopped.why}. Fix that, then resume (or abandon it)`,
        ),
        Effect.andThen(finishedLines(input)),
        Effect.flatMap((lines) => Effect.forEach([`${input.node} is set up.`, ...lines], step)),
      );

    /** Abandoning, once the run lock is held. */
    const abandonHeld = Effect.gen(function* () {
      const hub = yield* readHub(home());
      // What the hub's admission committed comes out again first; when it cannot, the hub stays to retry.
      const undone = Option.isSome(hub) ? yield* undoAdmission(hub.value, home()) : [];
      const dropped = yield* abandonRun(home());
      if (Option.isNone(dropped) && Option.isNone(hub))
        return yield* Effect.fail("there is no unfinished setup to abandon");
      yield* dropHub(home());
      const lines: Array<string> = [];
      if (Option.isSome(dropped)) {
        const { stopped, report } = dropped.value;
        if (stopped) lines.push(`It stopped at ${stopped.step}: ${stopped.why}`);
        lines.push(...report);
      }
      if (Option.isSome(hub))
        lines.push(
          `Dropped bringing up ${hub.value.node} as the hub; what its admission added to the fleet is taken out:`,
          ...undone.map((l) => `  ${l}`),
          `To add a hub later, set it up again from here (t3-fleet ui).`,
        );
      return lines;
    });

    // Holding the run lock throughout: no setup here starts or resumes while what it would use is taken out.
    const abandon: SetupActions["abandon"] = Effect.suspend(() =>
      withMachineLock(runLockPath(home()), abandonHeld, new RunningElsewhere()),
    ).pipe(
      Effect.provide(services),
      Effect.mapError((e) => (Schema.is(RunningElsewhere)(e) ? e : message(e))),
    );

    const apply: SetupActions["apply"] = (request) =>
      Effect.gen(function* () {
        if (request.kind === "resume") {
          const leaving = yield* leavingRefusal(home());
          if (Option.isSome(leaving)) return yield* Effect.fail(leaving.value);
          if (yield* runningElsewhere(home())) return yield* new RunningElsewhere();
          const unfinished = yield* unfinishedRun(home());
          const hub = Option.getOrNull(yield* readHub(home()));
          // A machine in a fleet brings a hub up only as an authority (bringUp checks again).
          const config = yield* member;
          if (hub !== null && config !== null) yield* requireAuthority(config);
          const jobs: Array<SetupJob> = [];
          if (Option.isSome(unfinished)) {
            const progress = unfinished.value;
            const { input, raw } = yield* resumeInput(progress, yield* preflight, {
              url: null,
              remote: null,
            });
            jobs.push(
              runJob(`Set up ${progress.node} (resumed)`, (step) =>
                stepsOf(input, raw, progress, step),
              ),
            );
          }
          if (hub !== null) jobs.push(hubJob(hub));
          if (jobs.length === 0)
            return yield* Effect.fail("there is no unfinished setup to resume");
          return jobs;
        }
        const found = (yield* Ref.get(plans)).get(request.planId);
        if (found === undefined)
          return yield* new StalePlan({
            message: "that plan is not this run's, or too old: plan again",
          });
        yield* mayStart;
        const scratch = yield* scratchFor;
        const now = yield* planned(found.request, scratch).pipe(
          Effect.tapError(() => removeScratch(scratch)),
        );
        if (now.digest !== request.planId) {
          yield* removeScratch(scratch);
          return yield* new StalePlan({
            message:
              "this machine or the fleet changed since the plan was made: plan again, and review what changed",
          });
        }
        // The hub as checked just now, which the digest covers: what the plan showed is what is written.
        const { p, missing, hub } = now;
        // Every choice names a conflict of this plan and one of its choices; a missing one takes the default.
        const choices: Record<string, Choice> = {};
        for (const [id, value] of Object.entries(request.choices)) {
          const conflict = p.plan.conflicts.find((c) => c.id === id);
          const choice = conflict?.choices.find((c) => c.value === value);
          if (conflict === undefined || choice === undefined) {
            yield* removeScratch(scratch);
            return yield* Effect.fail(`not a choice in this plan: ${id} = ${value}`);
          }
          choices[id] = choice.value;
        }
        // Like the terminal: a conflict that follows a choice is only asked while it still differs.
        for (const c of p.plan.conflicts)
          if (!applies(c, choices, p.plan.conflicts)) delete choices[c.id];
        const asked = new Set(missing.map((m) => m.name));
        const unknown = Object.keys(request.values).filter((n) => !asked.has(n));
        if (unknown.length > 0) {
          yield* removeScratch(scratch);
          return yield* Effect.fail(`not asked for in this plan: ${unknown.join(", ")}`);
        }
        const entered: Array<Secret> = Object.entries(request.values)
          .filter(([name, value]) => name !== MODEL_TOKEN && value !== "")
          .map(([name, value]) => ({ name, value, where: "entered during setup" }));
        const input = decideRun(p, {
          choices,
          entered,
          extras: extrasOf(p, found.request, request.values),
          upkeep: upkeepOf(p.mode, found.request),
        });
        const title = `Set up ${p.node}`;
        const local: SetupJob = p.nothing
          ? runJob(title, (step) =>
              Effect.gen(function* () {
                if (!p.pending) {
                  if (p.record !== null) yield* clearAbandoned(p.home);
                  return yield* step("Nothing here differs from the fleet.");
                }
                for (const line of yield* finishAbandoned(p)) yield* step(`✓ ${line}`);
                yield* step(`${p.node} is set up.`);
              }).pipe(Effect.mapError(message), Effect.ensuring(removeScratch(scratch))),
            )
          : runJob(title, (step) =>
              Effect.gen(function* () {
                const progress = yield* startRun(p, input, step);
                // Saved once the run is: a hub without a run to resume would show a setup that is not.
                if (hub !== null) yield* writeHub(p.home, hub);
                yield* stepsOf(input, p.found.raw, progress, step);
              }).pipe(Effect.mapError(message), Effect.ensuring(removeScratch(scratch))),
            );
        return hub === null ? [local] : [local, hubJob(hub)];
      }).pipe(
        Effect.provide(services),
        Effect.mapError((e) =>
          Schema.is(StalePlan)(e) || Schema.is(RunningElsewhere)(e) ? e : message(e),
        ),
      );

    const invite: SetupActions["invite"] = (node) =>
      closed(
        Effect.gen(function* () {
          if (!NODE_NAME.test(node))
            return yield* Effect.fail("names are lowercase letters, digits and dashes");
          const config = yield* loadConfig.pipe(
            Effect.mapError(() => "this machine is not set up yet: finish setup first"),
          );
          if (!config.nodes.find((n) => n.name === config.self)?.roles.includes("authority"))
            return yield* Effect.fail(`${config.self} is not an authority`);
          const url = out(yield* git(config.repo, ["remote", "get-url", "origin"]));
          if (url === "")
            return yield* Effect.fail(
              "the config repo has no origin remote yet; push it to a private repository first",
            );
          // Invited already: the same line again, nothing committed twice.
          if (node === config.self) return yield* Effect.fail(`${node} is this machine`);
          if (!config.nodes.some((n) => n.name === node))
            yield* waitForSyncLock(addNode(config.repo, node, null, []));
          return { command: inviteLine(url, node) };
        }),
      );

    const notifyTest: SetupActions["notifyTest"] = closed(
      Effect.gen(function* () {
        const config = yield* loadConfig.pipe(
          Effect.mapError(() => "this machine is not set up yet: finish setup first"),
        );
        return yield* testNotification(config);
      }),
    );

    return {
      state,
      notifyTest,
      probe: (ssh, repo) =>
        Effect.gen(function* () {
          // A machine in a fleet checks the hub against its own; otherwise against the repo asked about.
          const config = yield* member;
          const own =
            config === null
              ? ""
              : out(yield* git(config.repo, ["remote", "get-url", "origin"]).pipe(Effect.orDie));
          return yield* checkHub(ssh, own !== "" ? own : (repo ?? null));
        }).pipe(Effect.provide(services)),
      plan,
      apply,
      abandon,
      invite,
    } satisfies SetupActions;
  });
