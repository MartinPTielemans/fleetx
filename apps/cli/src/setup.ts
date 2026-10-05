/**
 * `t3-fleet setup`: one command from "nothing here" (or a pile of skills and
 * MCP servers) to a member of the fleet.
 *
 *   t3-fleet setup                       the first machine: starts a fleet
 *   t3-fleet setup <repo-url> [name]     any other machine: joins it
 *   t3-fleet setup                       again, on a machine set up before:
 *                                        what still differs from the fleet
 *
 * Plan first: pre-flight, then what this machine has, then one screen of
 * what setup would do. Nothing is written before the plan is confirmed:
 * a joining machine's plan reads a clone in a temporary directory, removed
 * unless setup goes ahead. `--plan` stops at the plan (with `--resume`, it
 * shows what is left of a stopped run), `--yes` takes every default.
 *
 * Once confirmed, the whole run is decided and saved (State.ts), its secret
 * values encrypted to this machine's key, before the first step. A run that
 * stops part-way continues with `--resume`, doing exactly what was decided,
 * or is dropped with `--abandon`.
 *
 * Besides what this machine holds, setup asks how the fleet looks after it:
 * `--auto-update` (on for a new fleet: sync applies updates by itself),
 * `--notify` (an OS notification here for every alert), `--ntfy` (alerts
 * pushed to a phone), and with `--relay`, `--mcp-hub` (the MCP servers run
 * there). `--no-…` says no to any of them; `--yes` takes their defaults.
 *
 * `--ui` asks the same questions in the browser: the setup wizard, served by
 * `t3-fleet ui` from the same engine (setup/Session.ts).
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { exec } from "@t3-fleet/core/Exec";
import { randomBytes } from "@t3-fleet/core/hub/Policy";
import { NTFY_SECRET, newNtfyUrl, UPDATE_WORDS, UPKEEP_DEFAULTS } from "@t3-fleet/core/Upkeep";
import {
  settingsLines,
  upkeepFor,
  type Extras,
  type SetupInput,
  type Upkeep,
} from "@t3-fleet/core/setup/Apply";
import type { Secret } from "@t3-fleet/core/setup/Credentials";
import { tilde, type Discovery } from "@t3-fleet/core/setup/Discover";
import {
  applies,
  detailOf,
  type Actions,
  type Choice,
  type Mode,
  type Plan,
} from "@t3-fleet/core/setup/Plan";
import { preflight, type Check, type Preflight } from "@t3-fleet/core/setup/Preflight";
import { SELF_SERVER } from "@t3-fleet/core/setup/Repo";
import {
  abandonRun,
  decideRun,
  finishAbandoned,
  finishedLines,
  leavingRefusal,
  prepare,
  resumeInput,
  RUN_ELSEWHERE,
  runningElsewhere,
  runSteps as runSessionSteps,
  savedSteps,
  startRun,
  unfinishedRun,
  withRunLock,
} from "@t3-fleet/core/setup/Session";
import { bringUp, dropHub, readHub, undoAdmission, updateHub } from "@t3-fleet/core/setup/Hub";
import { clearAbandoned, type Progress } from "@t3-fleet/core/setup/State";
import { unfinishedLines } from "@t3-fleet/core/setup/Unfinished";

import { reportUserErrors } from "./shared.ts";
import { connectT3 } from "./t3.ts";
import { serveUi } from "./ui.ts";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const mark = (c: Check) =>
  c.severity === "ok" ? "✓" : c.severity === "error" ? "✗" : c.severity === "warn" ? "!" : "·";

/** A secret as the plan shows it: never more than its first characters. */
export const mask = (value: string) => (value.length >= 12 ? `${value.slice(0, 3)}…` : "…");

const section = (title: string, rows: ReadonlyArray<string>) =>
  rows.length === 0 ? [] : ["", title, ...rows.map((r) => `  ${r}`)];

const MODE_LINE: Record<Mode, string> = {
  first: "first machine: starts a fleet",
  join: "joins a fleet",
  again: "set up already: what still differs from the fleet",
};

export const renderPlan = (
  plan: Plan,
  preview: Actions,
  input: {
    readonly checkout: string;
    readonly home: string;
    readonly pre: Preflight;
    readonly found: Discovery;
    readonly remote: string;
    readonly extras: ReadonlyArray<readonly [string, string]>;
    /** Whether the sync timer, off so far, can be turned on now. */
    readonly timer: boolean;
  },
) => {
  const t = (p: string) => tilde(p, input.home);
  const lines = [`T3 Fleet setup  ${plan.node}  ${MODE_LINE[plan.mode]} (${t(input.checkout)})`];
  lines.push(
    ...section(
      "Pre-flight",
      input.pre.checks.map((c) => `${mark(c)} ${c.title}${c.detail ? `\n      ${c.detail}` : ""}`),
    ),
  );

  const verb = plan.commits
    ? "Will add to the repo"
    : "Will propose to the fleet (an authority approves)";
  const skillRow = (name: string, from: string, source: { url: string; commit: string } | null) =>
    `${name}  from ${from}${source ? ` (${source.url} @ ${source.commit.slice(0, 7)})` : ""}`;
  const added = [
    ...preview.skills.map((s) => {
      const copy = [
        ...plan.add.skills,
        ...plan.conflicts.flatMap((c) => (c.kind === "skill" ? c.copies : [])),
      ].find((p) => p.copy.dir === s.from);
      return `skill   ${skillRow(s.name, copy?.copy.root ?? t(s.from), s.source)}`;
    }),
    ...preview.servers.map(
      (s) =>
        `server  ${s.name}${s.name === SELF_SERVER.name ? "  (T3 Fleet's own, for agents in T3)" : ""}${
          s.scope === "machine"
            ? `  this machine only: ${plan.add.servers.find((x) => x.name === s.name)?.why ?? ""}`
            : s.scope === "declared"
              ? `  declared, registered nowhere: ${plan.add.servers.find((x) => x.name === s.name)?.why ?? ""}`
              : ""
        }`,
    ),
    ...preview.instructions.map((i) => `file    ${i.dest} → ${i.src}`),
  ];
  lines.push(...section(verb, added));
  // Only worth saying on a machine joining: on one set up already, these are simply in place.
  if (plan.mode === "join")
    lines.push(
      ...section("Already the fleet's", [
        ...plan.same.skills.map((x) => `skill   ${x.name}`),
        ...plan.same.servers.map(
          (x) =>
            `server  ${x.name}${x.found.extracted.secrets.length > 0 ? "  (the fleet's credentials replace this machine's)" : ""}`,
        ),
        ...plan.same.instructions.map((x) => `file    ${x.dest}`),
      ]),
    );
  const linked = preview.links.filter((l) => l.link !== null);
  const aside = preview.links.filter((l) => l.link === null);
  lines.push(
    ...section("Will link (what is there now moves to ~/.local/state/t3-fleet/setup/backup)", [
      ...linked.map((l) => `${t(l.path)} → ${t(l.link ?? "")}`),
      ...aside.map((l) => `${t(l.path)}  moved aside only (agents read the linked copy)`),
    ]),
  );
  lines.push(
    ...section(
      "Conflicts (each is asked next; the default is first)",
      plan.conflicts.map(
        (c) => `${c.title}: ${c.choices.find((x) => x.value === c.default)?.label ?? c.default}`,
      ),
    ),
  );
  const t3 = input.found.t3;
  lines.push(
    ...section("Left alone", [
      ...preview.ignored.map(
        (i) => `server ${i.name}: ${i.why} ([mcp] "ignore.add" on this machine)`,
      ),
      ...plan.leftAlone.map((l) => `${l.what}: ${l.why}`),
      ...(t3.version === null
        ? ["T3: not found on this machine"]
        : [
            `T3 ${t3.version} (${t3.channel ?? "unknown channel"}${t3.running ? ", running" : ", not running"}): ${
              t3.providers
                .map((p) => `${p.instance} → ${p.resolved ?? p.binary ?? "?"}`)
                .join(", ") || "no providers"
            }`,
          ]),
      ...input.found.unreadable.map((u) => `${u}: skipped`),
    ]),
  );
  const width = Math.max(
    0,
    ...plan.secrets.map((s) => s.name.length),
    ...plan.missing.map((m) => m.name.length),
  );
  lines.push(
    ...section(
      plan.commits
        ? "Secrets (encrypted into the repo; never in plain text)"
        : "Secrets (proposed, encrypted, for an authority to merge)",
      plan.secrets.map((s) => `${s.name.padEnd(width)}  ${mask(s.value)}  ${s.where}`),
    ),
  );
  lines.push(
    ...section(
      "Missing (asked next; or later: t3-fleet secrets set NAME=…)",
      plan.missing.map((m) => `${m.name.padEnd(width)}  ${m.why}`),
    ),
  );
  lines.push(
    ...section(
      "Optional extras (each asked next; skippable)",
      input.extras.map(([n, why]) => `${n.padEnd(12)} ${why}`),
    ),
  );
  if (input.timer) lines.push("", "Sync timer  this machine can run it now: turned on");
  if (input.remote !== "") lines.push("", `Repository  ${input.remote}`);
  return lines.join("\n");
};

const interactive = () => process.stdin.isTTY === true && process.stdout.isTTY === true;

const ask = <A>(prompt: Prompt.Prompt<A>) =>
  Prompt.run(prompt).pipe(Effect.mapError(() => "setup stopped (nothing more was written)"));

/** Where the always-on machine is reached, from tailscale, and whether docker is there for the hub. */
const relayChecks = Effect.gen(function* () {
  const ts = yield* exec({
    command: "tailscale",
    args: ["status", "--json"],
    timeout: Duration.seconds(10),
  });
  const dns = /"DNSName"\s*:\s*"([^"]+)"/.exec(ts.stdout)?.[1]?.replace(/\.$/, "") ?? null;
  const docker = yield* exec({
    command: "docker",
    args: ["version", "--format", "{{.Server.Version}}"],
    timeout: Duration.seconds(10),
  });
  return {
    url: dns === null ? null : `https://${dns}:8399`,
    lines: [
      dns === null
        ? "! tailscale is not running here: other machines need [relay] url to reach it; set it once it is"
        : `✓ tailscale: other machines reach it at https://${dns}:8399`,
      docker.code === 0
        ? `✓ docker ${docker.stdout.trim()}: the hub can run container servers`
        : "! docker is not running here: the hub can still proxy remote servers and run commands",
    ],
  };
});

interface Flags {
  readonly url: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly planOnly: boolean;
  readonly yes: boolean;
  readonly resume: boolean;
  readonly abandon: boolean;
  readonly dir: Option.Option<string>;
  readonly github: Option.Option<string>;
  readonly remote: Option.Option<string>;
  readonly relay: boolean;
  readonly models: boolean;
  readonly mcpHub: Option.Option<boolean>;
  readonly autoUpdate: Option.Option<boolean>;
  readonly notify: Option.Option<boolean>;
  readonly ntfy: Option.Option<boolean>;
  readonly ui: boolean;
}

/** `t3-fleet setup`'s arguments and flags. */
export const setupFlags = {
  url: Argument.String("repo-url").pipe(
    Argument.withDescription(
      "The fleet's config repository, to join it. Leave out on the first machine.",
    ),
    Argument.optional,
  ),
  name: Argument.String("name").pipe(
    Argument.withDescription("This machine's name in the fleet; defaults to its hostname."),
    Argument.optional,
  ),
  planOnly: Flag.Boolean("plan").pipe(
    Flag.withDescription("Show the plan and stop; never writes anything."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Accept the defaults: every conflict's, no optional extras unless named, updates on for a new fleet, notifications where they can be shown.",
    ),
    Flag.withDefault(false),
  ),
  resume: Flag.Boolean("resume").pipe(
    Flag.withDescription("Continue a setup that stopped part-way, as it was decided."),
    Flag.withDefault(false),
  ),
  abandon: Flag.Boolean("abandon").pipe(
    Flag.withDescription("Drop a setup that stopped part-way; what it did already stays."),
    Flag.withDefault(false),
  ),
  dir: Flag.String("dir").pipe(
    Flag.withDescription(
      "Where the config repo lives here; defaults to ~/fleet, or the fleet's [fleet] checkout.",
    ),
    Flag.optional,
  ),
  github: Flag.String("github").pipe(
    Flag.withDescription(
      "First machine: the private GitHub repository to create (owner/name); defaults to <you>/t3-fleet.",
    ),
    Flag.optional,
  ),
  remote: Flag.String("remote").pipe(
    Flag.withDescription(
      "First machine: push to this existing, empty repository instead of creating one on GitHub.",
    ),
    Flag.optional,
  ),
  relay: Flag.Boolean("relay").pipe(
    Flag.withDescription("Make this machine the relay without asking."),
    Flag.withDefault(false),
  ),
  models: Flag.Boolean("models").pipe(
    Flag.withDescription("Set up the model proxy without asking."),
    Flag.withDefault(false),
  ),
  mcpHub: Flag.Boolean("mcp-hub").pipe(
    Flag.withDescription(
      "With --relay: host the fleet's MCP servers on this machine too. Sign in to each once, here; until then they stop working on your machines. Off by default.",
    ),
    Flag.optional,
  ),
  autoUpdate: Flag.Boolean("auto-update").pipe(
    Flag.withDescription(
      `A new fleet: sync applies updates by itself (${UPDATE_WORDS.join(", ")}). On by default; --no-auto-update leaves them for you to apply.`,
    ),
    Flag.optional,
  ),
  notify: Flag.Boolean("notify").pipe(
    Flag.withDescription(
      "An OS notification on this machine for every fleet alert. On by default where one can be shown; --no-notify turns it off.",
    ),
    Flag.optional,
  ),
  ntfy: Flag.Boolean("ntfy").pipe(
    Flag.withDescription(
      "Push every fleet alert to your phone with ntfy: setup makes a private topic, prints it, and keeps it among the secrets. Off by default.",
    ),
    Flag.optional,
  ),
  ui: Flag.Boolean("ui").pipe(
    Flag.withDescription("Set up in the browser instead: opens the setup wizard (t3-fleet ui)."),
    Flag.withDefault(false),
  ),
};

export const setupCommand = Command.make("setup", setupFlags).pipe(
  Command.withDescription(
    "Set this machine up: start a fleet, join one (with its URL), or show what still differs. Plan first, resumable.",
  ),
  Command.withHandler((flags) =>
    (flags.ui ? serveUi({ port: null, open: true }) : setup(flags)).pipe(reportUserErrors),
  ),
);

const setup = (flags: Flags) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    // A hub the wizard asked for whose bring-up has not finished: the terminal resumes or abandons it too.
    const hub = yield* readHub(home);
    if (flags.abandon) {
      if (yield* runningElsewhere(home)) return yield* Effect.fail(RUN_ELSEWHERE);
      if (Option.isSome(hub)) {
        yield* Console.log(`The bring-up of ${hub.value.node}, the hub, is abandoned:`);
        for (const line of yield* undoAdmission(hub.value, home)) yield* Console.log(`  ${line}`);
        yield* dropHub(home);
      }
      const dropped = yield* abandonRun(home);
      if (Option.isNone(dropped)) {
        if (Option.isNone(hub)) yield* Console.log("No unfinished setup to abandon.");
        return;
      }
      const { stopped, report } = dropped.value;
      if (stopped) yield* Console.log(`It stopped at ${stopped.step}: ${stopped.why}`);
      yield* Console.log(report.join("\n"));
      return;
    }
    const unfinished = yield* unfinishedRun(home);
    // Half a departure and a new setup would undo each other: leave finishes, or is set aside, first.
    const leaving = yield* leavingRefusal(home);
    if (Option.isSome(leaving)) return yield* Effect.fail(leaving.value);
    if (flags.resume) {
      if (Option.isNone(unfinished) && Option.isNone(hub))
        return yield* Effect.fail("there is no unfinished setup to resume");
      if (flags.planOnly) {
        if (Option.isSome(unfinished)) yield* showRemaining(unfinished.value);
        if (Option.isSome(hub))
          yield* Console.log(
            `The bring-up of ${hub.value.node}, the hub, is still to finish${hub.value.error === null ? "" : `: it stopped with ${hub.value.error}`}.`,
          );
        return;
      }
      if (Option.isSome(unfinished)) yield* resumeRun(unfinished.value, flags);
      if (Option.isSome(hub)) yield* resumeHub(home);
      return;
    }
    if (Option.isSome(unfinished) && !flags.planOnly) {
      const p = unfinished.value;
      return yield* Effect.fail(
        `an earlier setup stopped${p.failed ? ` at ${p.failed.step} (${p.failed.why})` : ""}; continue it with \`t3-fleet setup --resume\`, or drop it with \`t3-fleet setup --abandon\``,
      );
    }
    // A joining machine's clone for the plan lives outside HOME, and goes unless setup goes ahead.
    const scratch = `${process.env["TMPDIR"] ?? "/tmp"}/t3-fleet-setup-${yield* Clock.currentTimeMillis}`;
    return yield* planAndApply(flags, scratch).pipe(
      Effect.ensuring(
        exec({ command: "rm", args: ["-rf", scratch], timeout: Duration.seconds(30) }).pipe(
          Effect.ignore,
        ),
      ),
    );
  });

/** `--resume --plan`: what is left of a stopped run. Reads only. */
const showRemaining = (p: Progress) =>
  Effect.gen(function* () {
    yield* Console.log(
      `Setup of ${p.node} (${MODE_LINE[p.mode]}, ${p.checkout})${p.failed ? `\nstopped at ${p.failed.step}: ${p.failed.why}` : ""}`,
    );
    for (const step of savedSteps(p))
      yield* Console.log(`  ${step.done ? "✓" : "·"} ${step.title}`);
    yield* Console.log("\n--plan: nothing was written. t3-fleet setup --resume continues it.");
  });

const say = (line: string) => Console.log(line);

const planAndApply = (flags: Flags, scratch: string) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";

    // 1. Pre-flight.
    const pre = yield* preflight;
    if (pre.checks.some((c) => c.severity === "error")) {
      yield* Console.log(
        pre.checks.map((c) => `${mark(c)} ${c.title}${c.detail ? `  ${c.detail}` : ""}`).join("\n"),
      );
      return yield* Effect.fail("pre-flight failed; fix what is marked ✗ and run setup again");
    }

    // 2. Discover, and 3. plan, against the fleet this run belongs to (Session.ts).
    const p = yield* prepare(
      {
        url: Option.getOrNull(flags.url),
        name: Option.getOrNull(flags.name),
        dir: Option.getOrNull(flags.dir),
        remote: Option.isSome(flags.remote)
          ? { url: flags.remote.value }
          : Option.isSome(flags.github)
            ? { github: flags.github.value }
            : "default",
        asked: {
          relay: flags.relay,
          models: flags.models,
          upkeep: [flags.mcpHub, flags.autoUpdate, flags.notify, flags.ntfy].some(Option.isSome),
        },
        scratch,
      },
      pre,
      say,
    );
    const { plan, record, left, pending, nothing, node } = p;
    yield* Console.log(
      renderPlan(plan, p.preview, {
        checkout: p.checkout,
        home,
        pre,
        found: p.found,
        remote: p.remoteLine,
        extras: nothing ? [] : p.offers,
        timer: p.timerNow,
      }),
    );
    if (record !== null && left !== null && pending)
      yield* Console.log(
        `\nUnfinished from the setup of ${record.node} dropped with --abandon:\n${unfinishedLines(
          left,
          record,
        )
          .map((l) => `  ${l}`)
          .join("\n")}`,
      );
    if (nothing && !pending) {
      if (record !== null && !flags.planOnly) yield* clearAbandoned(home);
      yield* Console.log(
        "\nNothing here differs from the fleet. `t3-fleet status` checks everything else.",
      );
      return;
    }
    if (nothing && record !== null && left !== null) {
      if (flags.planOnly) return yield* Console.log("\n--plan: nothing was written.");
      if (!flags.yes) {
        if (!interactive())
          return yield* Effect.fail(
            "not a terminal: re-run with --yes to finish it, or --plan to only look",
          );
        if (!(yield* ask(Prompt.Confirm({ message: "Finish it?", initial: true }))))
          return yield* Console.log("Nothing was written.");
      }
      yield* Console.log("");
      for (const line of yield* finishAbandoned(p)) yield* Console.log(`✓ ${line}`);
      return yield* Console.log(`\n${node} is set up.`);
    }
    if (flags.planOnly) {
      yield* Console.log("\n--plan: nothing was written.");
      return;
    }
    if (!flags.yes) {
      if (!interactive())
        return yield* Effect.fail(
          "not a terminal: re-run with --yes to take the defaults, or --plan to only look",
        );
      if (
        !(yield* ask(
          Prompt.Confirm({
            message: "Go ahead? (each conflict and extra is asked next)",
            initial: true,
          }),
        ))
      )
        return yield* Console.log("Nothing was written.");
    }

    // 4. Resolve, each conflict in turn; one that follows a choice here only when it still differs.
    const choices: Record<string, Choice> = {};
    const entered: Array<Secret> = [];
    if (!flags.yes)
      for (const c of plan.conflicts) {
        if (!applies(c, choices, plan.conflicts)) continue;
        yield* Console.log(`\n${c.title}\n${detailOf(c, choices, p.fleet)}`);
        const ordered = [...c.choices].sort((a, b) =>
          a.value === c.default ? -1 : b.value === c.default ? 1 : 0,
        );
        choices[c.id] = yield* ask(
          Prompt.Select({
            message: c.title,
            choices: ordered.map((x) => ({ title: x.label, value: x.value })),
          }),
        );
      }
    if (!flags.yes && interactive())
      for (const m of plan.missing) {
        const value = Redacted.value(
          yield* ask(Prompt.Password({ message: `${m.name} (${m.why}); empty to set it later` })),
        );
        if (value !== "") entered.push({ name: m.name, value, where: "entered during setup" });
      }

    // 6. Optional extras, then how the fleet looks after this machine.
    const extras = yield* chooseExtras({
      flags,
      offers: p.offers,
      found: p.found,
      mode: p.mode,
      fleetRelay: p.fleetRelay,
    });
    const upkeep = yield* chooseUpkeep({
      flags,
      mode: p.mode,
      fleetNtfy: p.fleetNtfy,
      mcpHub: existingRelayHub(flags.mcpHub, extras, p.fleetRelay),
    });
    const input = decideRun(p, { choices, entered, extras, upkeep });
    const settings = settingsLines(input);
    if (settings.length > 0)
      yield* Console.log(["", "Settings", ...settings.map((l) => `  ${l}`)].join("\n"));

    // 5. Apply: the run is saved first, so a resume does exactly this; one process at a time.
    return yield* withRunLock(
      home,
      startRun(p, input, say).pipe(
        Effect.flatMap((progress) => runSteps(input, p.found.raw, progress)),
      ),
    );
  });

/** `--resume` with a hub still to bring up: as the wizard's resume does, from this terminal. */
const resumeHub = (home: string) =>
  withRunLock(
    home,
    Effect.gen(function* () {
      const saved = yield* readHub(home);
      if (Option.isNone(saved)) return;
      const hub = saved.value;
      yield* Console.log(`\nBringing up ${hub.node}, the hub`);
      yield* updateHub(home, (h) => ({ ...h, error: null }));
      yield* bringUp(hub, (line) => Console.log(line), home).pipe(
        Effect.tapError((why) => updateHub(home, (h) => ({ ...h, error: why })).pipe(Effect.ignore)),
        Effect.mapError(
          (why) =>
            `${hub.node}'s bring-up stopped: ${why}. Fix that, then \`t3-fleet setup --resume\` (or \`t3-fleet setup --abandon\` to take it out of the fleet)`,
        ),
      );
      yield* dropHub(home);
      yield* Console.log(`${hub.node} is up.`);
    }),
  );

/** `--resume`: the saved run, its secret values decrypted; nothing is planned again. */
const resumeRun = (progress: Progress, flags: Flags) =>
  Effect.gen(function* () {
    const pre = yield* preflight;
    const { input, raw } = yield* resumeInput(progress, pre, {
      url: Option.getOrNull(flags.url),
      remote: Option.isSome(flags.remote)
        ? { url: flags.remote.value }
        : Option.isSome(flags.github)
          ? { github: flags.github.value }
          : null,
    });
    yield* Console.log(
      `Resuming setup of ${progress.node} (${MODE_LINE[progress.mode]}); done: ${progress.done.join(", ") || "nothing yet"}`,
    );
    return yield* withRunLock(
      process.env["HOME"] ?? "",
      runSteps(input, raw, progress),
    );
  });

const runSteps = (input: SetupInput, raw: Discovery["raw"], start: Progress) =>
  Effect.gen(function* () {
    yield* Console.log("");
    yield* runSessionSteps(
      input,
      { t3Connect: connectT3.pipe(Effect.map((lines) => lines.join("; "))), raw },
      start,
      {
        done: (step, lines) =>
          Console.log(`✓ ${step.title}${lines.length > 0 ? `\n    ${lines.join("\n    ")}` : ""}`),
        failed: (step, why) => Console.log(`✗ ${step.title}: ${why}`),
        note: say,
      },
    ).pipe(
      Effect.mapError(
        (stopped) =>
          `setup stopped at "${stopped.step}"; fix that, then \`t3-fleet setup --resume\` (or \`t3-fleet setup --abandon\` to drop it)`,
      ),
    );
    yield* Console.log(`\n${input.node} is set up.`);
    for (const line of yield* finishedLines(input)) yield* Console.log(line);
    // Here only, never in the wizard's job events: the topic is a secret.
    const topic = input.upkeep?.ntfy?.url;
    if (topic != null)
      yield* Console.log(
        `Fleet alerts push to ${topic}: subscribe to it in the ntfy app. It is kept as the secret ${NTFY_SECRET}.`,
      );
    if (input.upkeep?.desktop === true || topic != null)
      yield* Console.log("Try the notifications: t3-fleet notify test");
  });

/**
 * --mcp-hub or --no-mcp-hub on a fleet whose relay is set up already: on,
 * served at that relay; off. A relay this run sets up carries its own
 * (Extras.relay.mcp); without either flag, nothing changes.
 */
export const existingRelayHub = (
  flag: Option.Option<boolean>,
  extras: Pick<Extras, "relay">,
  fleetRelay: string | null,
): { readonly gateway: string } | false | null => {
  if (Option.isNone(flag) || extras.relay !== null) return null;
  if (!flag.value) return false;
  return fleetRelay === null ? null : { gateway: fleetRelay };
};

/** Whether this machine can show an OS notification: a Mac, or a desktop session. */
const canNotifyHere = () =>
  process.platform === "darwin" ||
  (process.env["DISPLAY"] ?? "") !== "" ||
  (process.env["WAYLAND_DISPLAY"] ?? "") !== "";

/**
 * The flags as the run takes them, the wizard's choices by another name:
 * each flag given wins; `--yes` (or no terminal) takes the defaults; anything
 * else is asked. A machine set up already changes only what a flag names.
 */
export const upkeepFlags = (
  flags: Pick<Flags, "autoUpdate" | "notify" | "ntfy">,
  context: {
    readonly mode: "first" | "join" | "again";
    readonly fleetNtfy: boolean;
    readonly canNotify: boolean;
  },
): {
  readonly autoUpdate: boolean | null | "ask";
  readonly desktop: boolean | null | "ask";
  readonly ntfy: boolean | "ask";
} => {
  const again = context.mode === "again";
  return {
    autoUpdate: Option.getOrElse(flags.autoUpdate, () =>
      context.mode === "first" ? ("ask" as const) : null,
    ),
    // Named, it is set either way (--no-notify takes this machine out); unnamed on a machine set up, left.
    desktop: Option.getOrElse(flags.notify, () =>
      again ? null : context.canNotify ? ("ask" as const) : false,
    ),
    ntfy: context.fleetNtfy
      ? false
      : Option.getOrElse(flags.ntfy, () => (again ? false : ("ask" as const))),
  };
};

const chooseUpkeep = (input: {
  readonly flags: Flags;
  readonly mode: Mode;
  readonly fleetNtfy: boolean;
  /** The MCP hub as --mcp-hub / --no-mcp-hub set it on the fleet's relay; null leaves it. */
  readonly mcpHub: { readonly gateway: string } | false | null;
}) =>
  Effect.gen(function* () {
    const quiet = input.flags.yes || !interactive();
    const wanted = upkeepFlags(input.flags, {
      mode: input.mode,
      fleetNtfy: input.fleetNtfy,
      canNotify: canNotifyHere(),
    });
    const decide = (value: boolean | "ask", message: string, initial: boolean) =>
      value !== "ask"
        ? Effect.succeed(value)
        : quiet
          ? Effect.succeed(initial)
          : ask(Prompt.Confirm({ message, initial }));
    const autoUpdate =
      wanted.autoUpdate === null
        ? null
        : yield* decide(
            wanted.autoUpdate,
            `Keep things up to date automatically (${UPDATE_WORDS.join(" · ")})`,
            UPKEEP_DEFAULTS.autoUpdate,
          );
    const desktop =
      wanted.desktop === null
        ? null
        : yield* decide(
            wanted.desktop,
            "Notify you on this machine for every fleet alert",
            UPKEEP_DEFAULTS.desktop,
          );
    const ntfy = (yield* decide(
      wanted.ntfy,
      "Push fleet alerts to your phone with ntfy (setup makes a private topic)",
      UPKEEP_DEFAULTS.ntfy,
    ))
      ? newNtfyUrl()
      : null;
    if (ntfy !== null)
      yield* Console.log(
        `  Your ntfy topic: ${ntfy}\n  Subscribe to it in the ntfy app (or open it in a browser). Anyone with the link reads your alerts: keep it to yourself.`,
      );
    return upkeepFor(input.mode, {
      autoUpdate,
      desktop,
      ntfy,
      mcpHub: input.mcpHub,
    }) satisfies Upkeep;
  });

const chooseExtras = (input: {
  readonly flags: {
    readonly yes: boolean;
    readonly relay: boolean;
    readonly models: boolean;
    readonly mcpHub: Option.Option<boolean>;
  };
  readonly offers: ReadonlyArray<readonly [string, string]>;
  readonly found: Discovery;
  readonly mode: Mode;
  /** The fleet's relay URL, when it has a relay already: --mcp-hub turns its MCP hub on. */
  readonly fleetRelay: string | null;
}) =>
  Effect.gen(function* () {
    const offered = (name: string) => input.offers.some(([n]) => n === name);
    const want = (name: string, flag: boolean, why: string, initial: boolean) =>
      Effect.gen(function* () {
        if (!offered(name)) return false;
        if (flag) return true;
        if (input.flags.yes || !interactive()) return initial;
        return yield* ask(Prompt.Confirm({ message: `${name}: ${why}?`, initial }));
      });
    let relay: Extras["relay"] = null;
    if (
      yield* want(
        "relay",
        input.flags.relay,
        "is this machine always on (it becomes the relay)",
        false,
      )
    ) {
      const checks = yield* relayChecks;
      for (const line of checks.lines) yield* Console.log(`  ${line}`);
      // The MCP hub: off unless asked, as in the wizard.
      let mcp = Option.getOrElse(input.flags.mcpHub, () => UPKEEP_DEFAULTS.mcpHub);
      if (Option.isNone(input.flags.mcpHub) && !input.flags.yes && interactive())
        mcp = yield* ask(
          Prompt.Confirm({
            message:
              "Host your MCP servers here too? Sign in to each once, here, and every machine uses it; until you do, those servers stop working on your machines",
            initial: UPKEEP_DEFAULTS.mcpHub,
          }),
        );
      if (mcp && checks.url === null) {
        yield* Console.log(
          "  ! the MCP hub is reached at the relay's URL, and tailscale gives none here: set [relay] url, then [defaults.mcp] hub and gateway (docs/topologies.md)",
        );
        mcp = false;
      }
      relay = { url: checks.url, token: hex(randomBytes(32)), mcp };
    } else if (Option.getOrElse(input.flags.mcpHub, () => false) && input.fleetRelay === null)
      return yield* Effect.fail(
        "--mcp-hub hosts the MCP servers on the relay: pass --relay too, on the always-on machine",
      );
    let models: Extras["models"] = null;
    if (
      yield* want(
        "model proxy",
        input.flags.models,
        "route this fleet's providers through T3 Fleet's model proxy",
        false,
      )
    ) {
      let token: string | null = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? null;
      const claude = input.found.agents.find((a) => a.name === "claude")?.path ?? null;
      if (token === null && claude !== null && interactive() && !input.flags.yes) {
        yield* Console.log(
          "  Claude's login through the proxy uses a token that does not expire. In another terminal run:\n    claude setup-token\n  and paste the token it prints (empty to skip; later: t3-fleet secrets set CLAUDE_CODE_OAUTH_TOKEN=…)",
        );
        const value = Redacted.value(
          yield* ask(Prompt.Password({ message: "CLAUDE_CODE_OAUTH_TOKEN" })),
        );
        token = value === "" ? null : value;
      }
      models = { token };
    }
    const t3 = yield* want("T3 access", false, "give T3 Fleet a read-only token for T3 here", true);
    return { relay, models, t3 } satisfies Extras;
  });
