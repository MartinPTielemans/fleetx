/**
 * One run of setup, from what this machine and the fleet hold to a saved run
 * and its steps: the engine both front ends drive. `t3-fleet setup` asks its
 * questions in the terminal; `t3-fleet ui` asks them on screens (Wizard.ts).
 * Neither prompts here: what they decide comes in as arguments.
 *
 *   prepare      pre-flight passed: the mode, the fleet to plan against,
 *                discovery, the plan, and what an abandoned run left
 *   decideRun    the plan and the answers, as the run Apply.ts carries out
 *   startRun     finish an abandoned run's work, then save this run (State.ts),
 *                its secret values encrypted to this machine's key
 *   runSteps     each step not done yet, recorded as it finishes
 *   resumeInput  a saved run with its values back; nothing is planned again
 *   abandonRun   drop a saved run, recording what it did for the next setup
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProbeServices } from "../Area.ts";
import { sh } from "../Area.ts";
import { expandHome, loadConfig, loadConfigFrom } from "../Config.ts";
import { exec } from "../Exec.ts";
import { unfinishedDeparture } from "../Leave.ts";
import { FLEET_FILE } from "../Names.ts";
import { mergeProposedSecrets, parseDotenv } from "../ProposedSecrets.ts";
import { localSecretsPath, readRecipients, setVar } from "../Secrets.ts";
import { t3AccessPath } from "../T3Access.ts";
import {
  persistable,
  restored,
  secretsToStore,
  setupSteps,
  writtenPaths,
  type Extras,
  type SetupInput,
  type Step,
} from "./Apply.ts";
import type { Secret } from "./Credentials.ts";
import { cleanUrl, discover, discoverServers, nodeName, tilde, type Discovery } from "./Discover.ts";
import { extraOffers, type ExtraName } from "./Extras.ts";
import {
  buildPlan,
  decide,
  EMPTY_FLEET,
  type Actions,
  type Choice,
  type FleetView,
  type Mode,
  type Plan,
} from "./Plan.ts";
import type { Preflight } from "./Preflight.ts";
import { registeredByFleet } from "./RegisteredByFleet.ts";
import { cloneFleet, readFleet, SELF_SERVER, uncommittedFleetFiles } from "./Repo.ts";
import {
  dropRun,
  loadRunSecrets,
  readAbandoned,
  readProgress,
  recordAbandoned,
  runSecretsPath,
  saveRunSecrets,
  writeProgress,
  type Abandoned,
  type Progress,
} from "./State.ts";
import {
  abandonReport,
  finishWork,
  nothingUnfinished,
  unfinishedWork,
  type Unfinished,
} from "./Unfinished.ts";

export const NODE_NAME = /^[a-z0-9][a-z0-9-]*$/;

const homeDir = () => process.env["HOME"] ?? "";

/** What a front end says to the user as setup goes; a line (or a few) at a time. */
export type Say = (line: string) => Effect.Effect<void>;

/** The run a setup stopped part-way through, if one did. */
export const unfinishedRun = (home: string) =>
  readProgress(home).pipe(Effect.map(Option.filter((p) => p.finishedAt === null)));

/** Why setup must not start now: this machine is partway through leaving the fleet. */
export const leavingRefusal = (home: string) =>
  unfinishedDeparture(home).pipe(
    Effect.map(
      Option.map(
        (d) =>
          `this machine is partway through leaving the fleet (${d.node}); finish that with \`t3-fleet leave\`, or, if that departure is over or given up, set it aside with \`t3-fleet leave --retire\`, then run setup again`,
      ),
    ),
  );

export interface PrepareRequest {
  /** The fleet's repository, to join it; null on the first machine (or one set up already). */
  readonly url: string | null;
  /** This machine's node name; from its hostname when null. */
  readonly name: string | null;
  /** Where the config repo lives here; ~/fleet, or the fleet's [fleet] checkout, when null. */
  readonly dir: string | null;
  /**
   * First machine: the repository to create or push to. "default" creates
   * <gh account>/t3-fleet when gh is signed in, and stays local otherwise.
   */
  readonly remote: SetupInput["remote"] | "default";
  /** Extras asked for outright (--relay, --models): offered even on a machine set up already. */
  readonly asked: { readonly relay: boolean; readonly models: boolean };
  /** A joining machine's clone for the plan: outside HOME, removed unless setup goes ahead. */
  readonly scratch: string;
}

/** Everything a plan read and decided, before any question is asked. */
export interface Prepared {
  readonly home: string;
  readonly now: number;
  readonly pre: Preflight;
  readonly mode: Mode;
  readonly url: string | null;
  readonly scratch: string;
  readonly checkout: string;
  readonly fleet: FleetView;
  readonly node: string;
  readonly authority: boolean;
  readonly branch: string;
  readonly found: Discovery;
  readonly plan: Plan;
  readonly paths: { readonly home: string; readonly checkout: string };
  readonly remoteTarget: SetupInput["remote"];
  /** How the first machine's repository is shared, in words; "" on any other run. */
  readonly remoteLine: string;
  readonly offers: ReadonlyArray<readonly [ExtraName, string]>;
  /** Whether the sync timer, off so far, can be turned on now. */
  readonly timerNow: boolean;
  /** What the run does with every conflict's default. */
  readonly preview: Actions;
  /** A machine set up already on which nothing differs from the fleet. */
  readonly nothing: boolean;
  /** A run dropped with --abandon on this checkout, and what it left to do. */
  readonly record: Abandoned | null;
  readonly left: Unfinished | null;
  readonly pending: boolean;
}

/** The fleet's own MCP server, on every machine, unless the fleet or the run has it already. */
export const withSelf = (fleet: FleetView, actions: Actions): Actions =>
  fleet.servers.has(SELF_SERVER.name) || actions.servers.some((s) => s.name === SELF_SERVER.name)
    ? actions
    : { ...actions, servers: [...actions.servers, { ...SELF_SERVER, scope: "fleet" }] };

/**
 * Read this machine and the fleet, and plan. Writes nothing outside
 * `scratch`. `say` hears the one note that comes before a refusal.
 */
export const prepare = (request: PrepareRequest, pre: Preflight, say: Say) =>
  Effect.gen(function* () {
    const home = homeDir();
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;

    // Which kind of run this is, and the fleet to plan against.
    const config = yield* loadConfig.pipe(Effect.option);
    const url = request.url;
    const mode: Mode = Option.isSome(config) ? "again" : url !== null ? "join" : "first";
    if (mode === "again" && url !== null)
      yield* say(
        `This machine is already set up; comparing it with its own fleet, not ${cleanUrl(url)}.`,
      );
    let checkout = "";
    let fleet: FleetView = EMPTY_FLEET;
    let mcp: Readonly<Record<string, unknown>> = {};
    let timerOff = false;
    let branch = Option.match(config, { onNone: () => "main", onSome: (c) => c.branch });
    let node = request.name ?? "";
    let authority = mode === "first";
    if (mode === "again" && Option.isSome(config)) {
      checkout = config.value.repo;
      node = config.value.self;
      authority =
        config.value.nodes.find((n) => n.name === node)?.roles.includes("authority") ?? false;
      ({ view: fleet, mcp, timerOff } = yield* readFleet(checkout, node));
      // Planned against, or committed, an uncommitted edit would pass for the fleet's.
      const record = Option.filter(yield* readAbandoned(home), (a) => a.checkout === checkout);
      const dirty = yield* uncommittedFleetFiles(
        checkout,
        node,
        fleet,
        Option.match(record, { onNone: () => [], onSome: (a) => a.written }),
      );
      if (dirty.length > 0) {
        const files = dirty.map((l) => sh(l.slice(3))).join(" ");
        const repo = sh(checkout);
        return yield* Effect.fail(
          [
            `${checkout} has uncommitted changes to the fleet's files; setup would plan against them as if they were the fleet's:`,
            ...dirty.map((l) => `  ${l.slice(0, 3)}${JSON.stringify(l.slice(3)).slice(1, -1)}`),
            authority
              ? `Publish them first (\`git -C ${repo} add -- ${files} && git -C ${repo} commit -m "…"\`, then \`t3-fleet sync\`), or set them aside (\`git -C ${repo} stash push -u -m t3-fleet -- ${files}\`), then run setup again.`
              : `\`t3-fleet sync\` proposes edits under [fleet] auto_commit; set the rest aside (\`git -C ${repo} stash push -u -m t3-fleet -- ${files}\`), or wait for this machine's proposal to be approved; then run setup again.`,
          ].join("\n"),
        );
      }
    }
    if (mode === "join" && url !== null) {
      yield* cloneFleet(url, request.scratch);
      if (node === "")
        node = nodeName(
          (yield* exec({ command: "hostname", timeout: Duration.seconds(5) })).stdout.trim(),
        );
      ({ view: fleet, mcp } = yield* readFleet(request.scratch, node));
      const probe = yield* loadConfigFrom(request.scratch, node).pipe(Effect.option);
      checkout = path.resolve(
        expandHome(
          request.dir ?? (Option.isSome(probe) ? probe.value.checkout : "~/fleet"),
          home,
        ),
      );
      authority =
        Option.isSome(probe) &&
        (probe.value.nodes.find((n) => n.name === node)?.roles.includes("authority") ?? false);
      if (Option.isSome(probe)) branch = probe.value.branch;
    }

    // Discover.
    const found = yield* discover({
      taken: fleet.secretNames,
      managed: mode === "again" ? checkout : null,
    });
    if (node === "") node = found.node;
    if (!NODE_NAME.test(node))
      return yield* Effect.fail(
        `"${node}" is not a machine name: lowercase letters, digits and dashes`,
      );
    if (checkout === "") checkout = path.resolve(expandHome(request.dir ?? "~/fleet", home));

    // Plan. On a machine set up already, the fleet's own registrations are no difference.
    const local = parseDotenv(
      yield* fs.readFileString(localSecretsPath(home)).pipe(Effect.orElseSucceed(() => "")),
    );
    const registered =
      mode === "again"
        ? registeredByFleet({
            servers: fleet.servers,
            mcp,
            home,
            value: (n) => local.get(n) ?? process.env[n],
          })
        : undefined;
    const plan = buildPlan({
      mode,
      node,
      authority,
      found,
      fleet,
      ...(registered === undefined ? {} : { registered }),
    });
    const paths = { home, checkout };
    const remoteTarget: SetupInput["remote"] =
      mode !== "first"
        ? null
        : request.remote !== "default"
          ? request.remote
          : pre.github !== null
            ? { github: `${pre.github}/t3-fleet` }
            : null;
    const remoteLine =
      mode !== "first"
        ? ""
        : remoteTarget === null
          ? "local only for now: gh is not signed in (gh auth login), and no --remote was given; setup finishes here and says how to add one"
          : "github" in remoteTarget
            ? `gh repo create ${remoteTarget.github} --private`
            : `push to ${cleanUrl(remoteTarget.url)}`;
    const planned = mode === "join" ? request.scratch : checkout;
    const fleetText = yield* fs
      .readFileString(`${planned}/${FLEET_FILE}`)
      .pipe(Effect.orElseSucceed(() => ""));
    const nodeText = yield* fs
      .readFileString(`${planned}/nodes/${node}.toml`)
      .pipe(Effect.orElseSucceed(() => ""));
    // Only extras not set up yet, and on a machine set up already only those asked for (Extras.ts).
    const offers = extraOffers({
      mode,
      configured: {
        relay: mode !== "first" && /^\[relay\]/m.test(fleetText),
        "model proxy":
          mode !== "first" &&
          (/^\[defaults\.models\]/m.test(fleetText) || /^\[models\]/m.test(nodeText)),
        "T3 access": yield* fs.exists(t3AccessPath(home)).pipe(Effect.orElseSucceed(() => false)),
      },
      asked: { relay: request.asked.relay, "model proxy": request.asked.models },
      t3Running: found.t3.running,
    });
    const timerNow = mode === "again" && timerOff && pre.timer.works;
    const preview = withSelf(fleet, decide(plan, {}, paths));
    const nothing =
      mode === "again" &&
      preview.skills.length + preview.servers.length + preview.instructions.length === 0 &&
      preview.links.length + preview.ignored.length === 0 &&
      plan.conflicts.length === 0 &&
      plan.missing.length === 0 &&
      !timerNow;
    // What a run dropped with --abandon left undone: the checkout already has its files, so the plan cannot see it.
    const abandoned = mode === "again" ? yield* readAbandoned(home) : Option.none();
    const record = Option.getOrNull(Option.filter(abandoned, (a) => a.checkout === checkout));
    const left = record === null ? null : yield* unfinishedWork(home, record, authority, branch);
    const pending = left !== null && !nothingUnfinished(left);
    return {
      home,
      now,
      pre,
      mode,
      url,
      scratch: request.scratch,
      checkout,
      fleet,
      node,
      authority,
      branch,
      found,
      plan,
      paths,
      remoteTarget,
      remoteLine,
      offers,
      timerNow,
      preview,
      nothing,
      record,
      left,
      pending,
    } satisfies Prepared;
  });

/** The run, decided: the plan with the conflicts' choices, the values entered, and the extras. */
export const decideRun = (
  p: Prepared,
  answers: {
    readonly choices: Readonly<Record<string, Choice>>;
    readonly entered: ReadonlyArray<Secret>;
    readonly extras: Extras;
  },
): SetupInput => {
  const actions = withSelf(p.fleet, decide(p.plan, answers.choices, p.paths, answers.entered));
  const keep = new Set([...actions.ignored.map((i) => i.name), ...actions.serversHereOnly]);
  return {
    mode: p.mode,
    node: p.node,
    checkout: p.checkout,
    join: p.mode === "join" && p.url !== null ? { url: p.url, clone: p.scratch } : null,
    commits: p.plan.commits,
    actions,
    handed: p.found.servers
      .filter((s) => s.project === null && !keep.has(s.name))
      .map((s) => s.name),
    extras: answers.extras,
    timer: p.pre.timer,
    remote: p.remoteTarget,
    now: p.now,
    branch: p.branch,
  };
};

/** Every step a run takes, by title; for showing a plan, never run. */
export const stepTitles = (input: SetupInput) =>
  setupSteps(input, { t3Connect: Effect.succeed(""), raw: { claude: null, codex: null } }).map(
    (s) => s.title,
  );

/**
 * Finish what an abandoned run left (published or marked for proposing now;
 * this run's sync does the rest), then save this run, before its first step:
 * a resume does exactly this.
 */
export const startRun = (p: Prepared, input: SetupInput, say: Say) =>
  Effect.gen(function* () {
    if (p.record !== null && p.left !== null && p.pending)
      for (const line of yield* finishWork(p.home, p.record, p.left, {
        sync: false,
        branch: p.branch,
      }))
        yield* say(`✓ ${line}`);
    let plain = "";
    for (const s of secretsToStore(input)) plain = setVar(plain, s.name, s.value);
    yield* saveRunSecrets(p.home, p.now, plain);
    const progress: Progress = {
      startedAt: p.now,
      mode: p.mode,
      node: p.node,
      checkout: p.checkout,
      url: p.url === null ? null : cleanUrl(p.url),
      input: persistable(input),
      done: [],
      failed: null,
      finishedAt: null,
    };
    yield* writeProgress(p.home, progress);
    return progress;
  });

/** On a machine where nothing differs: finish what an abandoned run left, sync included. */
export const finishAbandoned = (p: Prepared) =>
  p.record === null || p.left === null
    ? Effect.succeed([] as ReadonlyArray<string>)
    : finishWork(p.home, p.record, p.left, { sync: true, branch: p.branch });

/** How a front end hears each step. */
export interface StepReport {
  readonly started?: (step: Step) => Effect.Effect<void>;
  readonly done: (step: Step, lines: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly failed: (step: Step, why: string) => Effect.Effect<void>;
  /** Anything else done along the way, a line each. */
  readonly note: (line: string) => Effect.Effect<void>;
}

/** The step a run stopped at, and why; the front end says how to go on. */
export interface Stopped {
  readonly step: string;
  readonly why: string;
}

/** Each step not done yet, in order, recorded as it finishes; the run is finished when they all are. */
export const runSteps = (
  input: SetupInput,
  hooks: {
    readonly t3Connect: Effect.Effect<string, string, ProbeServices>;
    readonly raw: Discovery["raw"];
  },
  start: Progress,
  report: StepReport,
): Effect.Effect<void, Stopped, ProbeServices> =>
  Effect.gen(function* () {
    const home = homeDir();
    const fs = yield* FileSystem.FileSystem;
    let progress = start;
    for (const step of setupSteps(input, hooks)) {
      if (progress.done.includes(step.id)) continue;
      if (report.started !== undefined) yield* report.started(step);
      const result = yield* step.run.pipe(Effect.result);
      if (result._tag === "Failure") {
        progress = { ...progress, failed: { step: step.id, why: result.failure } };
        yield* writeProgress(home, progress).pipe(Effect.ignore);
        yield* report.failed(step, result.failure);
        return yield* Effect.fail<Stopped>({ step: step.id, why: result.failure });
      }
      yield* report.done(step, result.success);
      progress = { ...progress, done: [...progress.done, step.id], failed: null };
      yield* writeProgress(home, progress).pipe(
        Effect.mapError(() => ({ step: step.id, why: "could not record its progress" })),
      );
    }
    if (input.commits && input.mode === "again") {
      // Proposed secrets an approval elsewhere could not read: this authority may.
      for (const line of yield* mergeProposedSecrets(input.checkout).pipe(
        Effect.mapError((e) => ({ step: "secrets", why: typeof e === "string" ? e : e.message })),
      ))
        yield* report.note(`✓ ${line}`);
    }
    const finished = yield* Clock.currentTimeMillis;
    yield* writeProgress(home, { ...progress, finishedAt: finished }).pipe(Effect.ignore);
    yield* fs.remove(runSecretsPath(home), { force: true }).pipe(Effect.ignore);
  });

/** What to say once a run is done, after "<node> is set up.", a message each. */
export const finishedLines = (input: SetupInput) =>
  Effect.gen(function* () {
    const home = homeDir();
    const lines: Array<string> = [];
    if (input.mode === "first") {
      const t = tilde(input.checkout, home);
      if (input.remote === null)
        lines.push(
          `The repo is local for now. To share it, push it to a private repository and sync:\n  git -C ${t} remote add origin <url> && git -C ${t} push -u origin main\n  t3-fleet sync`,
        );
      lines.push("Add another machine: t3-fleet invite <name>, then run what it prints there.");
    } else if (!input.commits) {
      if (
        input.actions.skills.length +
          input.actions.servers.length +
          input.actions.instructions.length +
          secretsToStore(input).length >
        0
      )
        lines.push(
          `What this machine adds is proposed: on an authority, t3-fleet review, then t3-fleet approve ${input.node}.`,
        );
      const recipients = yield* readRecipients(input.checkout).pipe(
        Effect.orElseSucceed(() => ({}) as Record<string, string>),
      );
      if (recipients[input.node] === undefined)
        lines.push(
          "An authority's next sync adds this machine's key; then it reads the fleet's secrets.",
        );
    }
    return lines as ReadonlyArray<string>;
  });

/**
 * A saved run, ready to go on: its values decrypted, whether it commits as
 * the repo says now, the timer as this machine finds it now. `overrides`
 * are what the command line may change on a resume.
 */
export const resumeInput = (
  progress: Progress,
  pre: Preflight,
  overrides: { readonly url: string | null; readonly remote: SetupInput["remote"] | null },
) =>
  Effect.gen(function* () {
    const home = homeDir();
    const fs = yield* FileSystem.FileSystem;
    const saved = progress.input as SetupInput;
    // An authority may have been made of this machine (or not) since.
    const nodeText = yield* fs
      .readFileString(`${saved.checkout}/nodes/${saved.node}.toml`)
      .pipe(Effect.option);
    const back = restored(saved, yield* loadRunSecrets(home, progress.startedAt));
    if ("missing" in back)
      return yield* Effect.fail(
        `the saved values of ${back.missing.join(", ")} are missing; this run cannot resume without them. \`t3-fleet setup --abandon\` drops it, then run setup again`,
      );
    const input: SetupInput = {
      ...back,
      commits:
        saved.mode === "first" ||
        (Option.isSome(nodeText) ? /^roles\s*=.*"authority"/m.test(nodeText.value) : saved.commits),
      timer: pre.timer,
      join:
        saved.join === null
          ? null
          : { ...saved.join, url: overrides.url ?? saved.join.url },
      remote: overrides.remote ?? saved.remote,
    };
    // The clients' entries are only read when the snapshot is still to be taken.
    const raw = progress.done.includes("snapshot")
      ? { claude: null, codex: null }
      : (yield* discoverServers(home, process.env, [])).raw;
    return { input, raw };
  });

/** The steps of a saved run, each with whether it is done. */
export const savedSteps = (progress: Progress) =>
  setupSteps(progress.input as SetupInput, {
    t3Connect: Effect.succeed(""),
    raw: { claude: null, codex: null },
  }).map((s) => ({ id: s.id, title: s.title, done: progress.done.includes(s.id) }));

/**
 * Drop the unfinished run. What it did stays, recorded (no values) for the
 * next setup to finish. None when there was nothing to drop.
 */
export const abandonRun = (home: string) =>
  Effect.gen(function* () {
    const unfinished = yield* unfinishedRun(home);
    if (Option.isNone(unfinished)) return Option.none<AbandonOutcome>();
    const p = unfinished.value;
    const saved = p.input as SetupInput;
    // The next setup finishes what this run started (Unfinished.ts); the record has no values.
    const record = {
      startedAt: p.startedAt,
      abandonedAt: yield* Clock.currentTimeMillis,
      node: p.node,
      mode: p.mode,
      checkout: p.checkout,
      commits: saved.commits,
      done: p.done,
      written: writtenPaths(saved),
    };
    if (p.done.length > 0) yield* recordAbandoned(home, record);
    yield* dropRun(home);
    const steps = setupSteps(saved, {
      t3Connect: Effect.fail("not run"),
      raw: { claude: null, codex: null },
    }).map((s) => s.id);
    return Option.some<AbandonOutcome>({
      stopped: p.failed,
      report: abandonReport(record, steps, home),
    });
  });

export interface AbandonOutcome {
  readonly stopped: Progress["failed"];
  readonly report: ReadonlyArray<string>;
}
