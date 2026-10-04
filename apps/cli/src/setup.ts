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
 */
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { expandHome, loadConfig, loadConfigFrom } from "@t3-fleet/core/Config";
import { exec } from "@t3-fleet/core/Exec";
import { randomBytes } from "@t3-fleet/core/hub/Policy";
import { FLEET_FILE } from "@t3-fleet/core/Names";
import { mergeProposedSecrets, parseDotenv } from "@t3-fleet/core/ProposedSecrets";
import { localSecretsPath, readRecipients, setVar } from "@t3-fleet/core/Secrets";
import {
  persistable,
  restored,
  secretsToStore,
  setupSteps,
  writtenPaths,
  type Extras,
  type SetupInput,
} from "@t3-fleet/core/setup/Apply";
import type { Secret } from "@t3-fleet/core/setup/Credentials";
import {
  cleanUrl,
  discover,
  discoverServers,
  nodeName,
  tilde,
  type Discovery,
} from "@t3-fleet/core/setup/Discover";
import {
  applies,
  buildPlan,
  decide,
  detailOf,
  EMPTY_FLEET,
  type Actions,
  type Choice,
  type FleetView,
  type Mode,
  type Plan,
} from "@t3-fleet/core/setup/Plan";
import { preflight, type Check, type Preflight } from "@t3-fleet/core/setup/Preflight";
import { registeredByFleet } from "@t3-fleet/core/setup/RegisteredByFleet";
import { cloneFleet, readFleet, SELF_SERVER } from "@t3-fleet/core/setup/Repo";
import {
  clearAbandoned,
  dropRun,
  loadRunSecrets,
  readAbandoned,
  readProgress,
  recordAbandoned,
  runSecretsPath,
  saveRunSecrets,
  writeProgress,
  type Progress,
} from "@t3-fleet/core/setup/State";

import {
  abandonReport,
  finishWork,
  nothingUnfinished,
  unfinishedLines,
  unfinishedWork,
} from "@t3-fleet/core/setup/Unfinished";

import { reportUserErrors } from "./shared.ts";
import { connectT3 } from "./t3.ts";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
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
}

export const setupCommand = Command.make("setup", {
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
      "Accept the defaults: every conflict's, and no optional extras unless named.",
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
}).pipe(
  Command.withDescription(
    "Set this machine up: start a fleet, join one (with its URL), or show what still differs. Plan first, resumable.",
  ),
  Command.withHandler((flags) => setup(flags).pipe(reportUserErrors)),
);

const setup = (flags: Flags) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const unfinished = Option.filter(yield* readProgress(home), (p) => p.finishedAt === null);
    if (flags.abandon) {
      if (Option.isNone(unfinished)) return yield* Console.log("No unfinished setup to abandon.");
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
      if (p.failed) yield* Console.log(`It stopped at ${p.failed.step}: ${p.failed.why}`);
      yield* Console.log(abandonReport(record, steps, home).join("\n"));
      return;
    }
    if (flags.resume) {
      if (Option.isNone(unfinished))
        return yield* Effect.fail("there is no unfinished setup to resume");
      if (flags.planOnly) return yield* showRemaining(unfinished.value);
      return yield* resumeRun(unfinished.value, flags);
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
    const input = p.input as SetupInput;
    const steps = setupSteps(input, {
      t3Connect: Effect.succeed(""),
      raw: { claude: null, codex: null },
    });
    yield* Console.log(
      `Setup of ${p.node} (${MODE_LINE[p.mode]}, ${p.checkout})${p.failed ? `\nstopped at ${p.failed.step}: ${p.failed.why}` : ""}`,
    );
    for (const step of steps)
      yield* Console.log(`  ${p.done.includes(step.id) ? "✓" : "·"} ${step.title}`);
    yield* Console.log("\n--plan: nothing was written. t3-fleet setup --resume continues it.");
  });

const planAndApply = (flags: Flags, scratch: string) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const now = yield* Clock.currentTimeMillis;

    // 1. Pre-flight.
    const pre = yield* preflight;
    if (pre.checks.some((c) => c.severity === "error")) {
      yield* Console.log(
        pre.checks.map((c) => `${mark(c)} ${c.title}${c.detail ? `  ${c.detail}` : ""}`).join("\n"),
      );
      return yield* Effect.fail("pre-flight failed; fix what is marked ✗ and run setup again");
    }

    // Which kind of run this is, and the fleet to plan against.
    const config = yield* loadConfig.pipe(Effect.option);
    const url = Option.getOrNull(flags.url);
    const mode: Mode = Option.isSome(config) ? "again" : url !== null ? "join" : "first";
    if (mode === "again" && url !== null)
      yield* Console.log(
        `This machine is already set up; comparing it with its own fleet, not ${cleanUrl(url)}.`,
      );
    let checkout = "";
    let fleet: FleetView = EMPTY_FLEET;
    let mcp: Readonly<Record<string, unknown>> = {};
    let timerOff = false;
    let node = Option.getOrNull(flags.name) ?? "";
    let authority = mode === "first";
    if (mode === "again" && Option.isSome(config)) {
      checkout = config.value.repo;
      node = config.value.self;
      authority =
        config.value.nodes.find((n) => n.name === node)?.roles.includes("authority") ?? false;
      ({ view: fleet, mcp, timerOff } = yield* readFleet(checkout, node));
    }
    if (mode === "join" && url !== null) {
      yield* cloneFleet(url, scratch);
      if (node === "")
        node = nodeName(
          (yield* exec({ command: "hostname", timeout: Duration.seconds(5) })).stdout.trim(),
        );
      ({ view: fleet, mcp } = yield* readFleet(scratch, node));
      const probe = yield* loadConfigFrom(scratch, node).pipe(Effect.option);
      checkout = path.resolve(
        expandHome(
          Option.getOrElse(flags.dir, () =>
            Option.isSome(probe) ? probe.value.checkout : "~/fleet",
          ),
          home,
        ),
      );
      authority =
        Option.isSome(probe) &&
        (probe.value.nodes.find((n) => n.name === node)?.roles.includes("authority") ?? false);
    }

    // 2. Discover.
    const found = yield* discover({
      taken: fleet.secretNames,
      managed: mode === "again" ? checkout : null,
    });
    if (node === "") node = found.node;
    if (!NAME.test(node))
      return yield* Effect.fail(
        `"${node}" is not a machine name: lowercase letters, digits and dashes`,
      );
    if (checkout === "")
      checkout = path.resolve(
        expandHome(
          Option.getOrElse(flags.dir, () => "~/fleet"),
          home,
        ),
      );

    // 3. Plan. On a machine set up already, the fleet's own registrations are no difference.
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
    const withSelf = (actions: Actions): Actions =>
      fleet.servers.has(SELF_SERVER.name) ||
      actions.servers.some((s) => s.name === SELF_SERVER.name)
        ? actions
        : { ...actions, servers: [...actions.servers, { ...SELF_SERVER, scope: "fleet" }] };
    const remoteTarget: SetupInput["remote"] =
      mode !== "first"
        ? null
        : Option.isSome(flags.remote)
          ? { url: flags.remote.value }
          : Option.isSome(flags.github)
            ? { github: flags.github.value }
            : pre.github !== null
              ? { github: `${pre.github}/t3-fleet` }
              : null;
    const remote =
      mode !== "first"
        ? ""
        : remoteTarget === null
          ? "local only for now: gh is not signed in (gh auth login), and no --remote was given; setup finishes here and says how to add one"
          : "github" in remoteTarget
            ? `gh repo create ${remoteTarget.github} --private`
            : `push to ${cleanUrl(remoteTarget.url)}`;
    const fleetHasRelay =
      mode !== "first" &&
      /^\[relay\]/m.test(
        yield* fs
          .readFileString(`${mode === "join" ? scratch : checkout}/${FLEET_FILE}`)
          .pipe(Effect.orElseSucceed(() => "")),
      );
    const offers: Array<readonly [string, string]> = [
      ...(fleetHasRelay
        ? []
        : [
            ["relay", "an always-on machine gives instant sync and holds your MCP logins"] as const,
          ]),
      ["model proxy", "retries, stats, a login that doesn't expire"] as const,
      ...(found.t3.running
        ? [["T3 access", "provider logins and health as T3 itself sees them"] as const]
        : []),
    ];
    const timerNow = mode === "again" && timerOff && pre.timer.works;
    const preview = withSelf(decide(plan, {}, paths));
    const nothing =
      mode === "again" &&
      preview.skills.length + preview.servers.length + preview.instructions.length === 0 &&
      preview.links.length + preview.ignored.length === 0 &&
      plan.conflicts.length === 0 &&
      plan.missing.length === 0 &&
      !timerNow;
    yield* Console.log(
      renderPlan(plan, preview, {
        checkout,
        home,
        pre,
        found,
        remote,
        extras: nothing ? [] : offers,
        timer: timerNow,
      }),
    );
    // What a run dropped with --abandon left undone: the checkout already has its files, so the plan cannot see it.
    const abandoned = mode === "again" ? yield* readAbandoned(home) : Option.none();
    const record = Option.getOrNull(Option.filter(abandoned, (a) => a.checkout === checkout));
    const left = record === null ? null : yield* unfinishedWork(home, record, authority);
    const pending = left !== null && !nothingUnfinished(left);
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
      for (const line of yield* finishWork(home, record, left, { sync: true }))
        yield* Console.log(`✓ ${line}`);
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
        yield* Console.log(`\n${c.title}\n${detailOf(c, choices, fleet)}`);
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

    // 6. Optional extras.
    const extras = yield* chooseExtras({ flags, offers, found, mode });

    const actions = withSelf(decide(plan, choices, paths, entered));
    const keep = new Set([...actions.ignored.map((i) => i.name), ...actions.serversHereOnly]);
    const input: SetupInput = {
      mode,
      node,
      checkout,
      join: mode === "join" && url !== null ? { url, clone: scratch } : null,
      commits: plan.commits,
      actions,
      handed: found.servers
        .filter((s) => s.project === null && !keep.has(s.name))
        .map((s) => s.name),
      extras,
      timer: pre.timer,
      remote: remoteTarget,
      now,
    };

    // What an abandoned run left: published or marked for proposing now; this run's sync does the rest.
    if (record !== null && left !== null && pending)
      for (const line of yield* finishWork(home, record, left, { sync: false }))
        yield* Console.log(`✓ ${line}`);

    // 5. Apply: the run is saved first, so a resume does exactly this.
    let plain = "";
    for (const s of secretsToStore(input)) plain = setVar(plain, s.name, s.value);
    yield* saveRunSecrets(home, now, plain);
    const progress: Progress = {
      startedAt: now,
      mode,
      node,
      checkout,
      url: url === null ? null : cleanUrl(url),
      input: persistable(input),
      done: [],
      failed: null,
      finishedAt: null,
    };
    yield* writeProgress(home, progress);
    return yield* runSteps(input, found.raw, progress);
  });

/** `--resume`: the saved run, its secret values decrypted; nothing is planned again. */
const resumeRun = (progress: Progress, flags: Flags) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const fs = yield* FileSystem.FileSystem;
    const saved = progress.input as SetupInput;
    // An authority may have been made of this machine (or not) since.
    const nodeText = yield* fs
      .readFileString(`${saved.checkout}/nodes/${saved.node}.toml`)
      .pipe(Effect.option);
    const pre = yield* preflight;
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
          : { ...saved.join, url: Option.getOrElse(flags.url, () => saved.join?.url ?? "") },
      remote: Option.isSome(flags.remote)
        ? { url: flags.remote.value }
        : Option.isSome(flags.github)
          ? { github: flags.github.value }
          : saved.remote,
    };
    yield* Console.log(
      `Resuming setup of ${progress.node} (${MODE_LINE[progress.mode]}); done: ${progress.done.join(", ") || "nothing yet"}`,
    );
    // The clients' entries are only read when the snapshot is still to be taken.
    const raw = progress.done.includes("snapshot")
      ? { claude: null, codex: null }
      : (yield* discoverServers(home, process.env, [])).raw;
    return yield* runSteps(input, raw, progress);
  });

const runSteps = (input: SetupInput, raw: Discovery["raw"], start: Progress) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const fs = yield* FileSystem.FileSystem;
    let progress = start;
    const steps = setupSteps(input, {
      t3Connect: connectT3.pipe(Effect.map((lines) => lines.join("; "))),
      raw,
    });
    yield* Console.log("");
    for (const step of steps) {
      if (progress.done.includes(step.id)) continue;
      const result = yield* step.run.pipe(Effect.result);
      if (result._tag === "Failure") {
        progress = { ...progress, failed: { step: step.id, why: result.failure } };
        yield* writeProgress(home, progress);
        yield* Console.log(`✗ ${step.title}: ${result.failure}`);
        return yield* Effect.fail(
          `setup stopped at "${step.id}"; fix that, then \`t3-fleet setup --resume\` (or \`t3-fleet setup --abandon\` to drop it)`,
        );
      }
      yield* Console.log(
        `✓ ${step.title}${result.success.length > 0 ? `\n    ${result.success.join("\n    ")}` : ""}`,
      );
      progress = { ...progress, done: [...progress.done, step.id], failed: null };
      yield* writeProgress(home, progress);
    }
    if (input.commits && input.mode === "again") {
      // Proposed secrets an approval elsewhere could not read: this authority may.
      for (const line of yield* mergeProposedSecrets(input.checkout))
        yield* Console.log(`✓ ${line}`);
    }
    yield* writeProgress(home, { ...progress, finishedAt: yield* Clock.currentTimeMillis });
    yield* fs.remove(runSecretsPath(home), { force: true });

    yield* Console.log(`\n${input.node} is set up.`);
    if (input.mode === "first") {
      const t = tilde(input.checkout, home);
      if (input.remote === null)
        yield* Console.log(
          `The repo is local for now. To share it, push it to a private repository and sync:\n  git -C ${t} remote add origin <url> && git -C ${t} push -u origin main\n  t3-fleet sync`,
        );
      yield* Console.log(
        "Add another machine: t3-fleet invite <name>, then run what it prints there.",
      );
    } else if (!input.commits) {
      if (
        input.actions.skills.length +
          input.actions.servers.length +
          input.actions.instructions.length +
          secretsToStore(input).length >
        0
      )
        yield* Console.log(
          `What this machine adds is proposed: on an authority, t3-fleet review, then t3-fleet approve ${input.node}.`,
        );
      const recipients = yield* readRecipients(input.checkout);
      if (recipients[input.node] === undefined)
        yield* Console.log(
          "An authority's next sync adds this machine's key; then it reads the fleet's secrets.",
        );
    }
  });

const chooseExtras = (input: {
  readonly flags: { readonly yes: boolean; readonly relay: boolean; readonly models: boolean };
  readonly offers: ReadonlyArray<readonly [string, string]>;
  readonly found: Discovery;
  readonly mode: Mode;
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
      relay = { url: checks.url, token: hex(randomBytes(32)) };
    }
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
