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
 * what setup would do. Nothing is written before the plan is confirmed.
 * `--plan` stops there, `--yes` takes every default, and a run that fails
 * part-way continues with `--resume` (progress in setup.json, State.ts).
 */
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Clock from "effect/Clock";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { expandHome, loadConfig, loadConfigFrom } from "@t3-fleet/core/Config";
import { exec } from "@t3-fleet/core/Exec";
import { ensureGitConfig, git, ok, why } from "@t3-fleet/core/Git";
import { randomBytes } from "@t3-fleet/core/hub/Policy";
import { FLEET_FILE, stateDir } from "@t3-fleet/core/Names";
import { readRecipients } from "@t3-fleet/core/Secrets";
import {
  mergeProposedSecrets,
  secretsToStore,
  setupSteps,
  type Extras,
  type SetupInput,
} from "@t3-fleet/core/setup/Apply";
import type { Secret } from "@t3-fleet/core/setup/Credentials";
import { discover, nodeName, tilde, type Discovery } from "@t3-fleet/core/setup/Discover";
import {
  buildPlan,
  decide,
  EMPTY_FLEET,
  type Actions,
  type Choice,
  type FleetView,
  type Mode,
  type Plan,
} from "@t3-fleet/core/setup/Plan";
import { preflight, type Check, type Preflight } from "@t3-fleet/core/setup/Preflight";
import { readFleet, SELF_SERVER } from "@t3-fleet/core/setup/Repo";
import { readProgress, writeProgress, type Progress } from "@t3-fleet/core/setup/State";

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
  if (input.remote !== "") lines.push("", `Repository  ${input.remote}`);
  lines.push(...section("Cannot go ahead", plan.blocked));
  return lines.join("\n");
};

/** Actions as stored in setup.json: no secret values. */
const withoutValues = (actions: Actions) => ({
  ...actions,
  secrets: actions.secrets.map((s) => ({ ...s, value: "" })),
});

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
    Flag.withDescription("Show the plan and stop."),
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
    Flag.withDescription("Continue a setup that stopped part-way."),
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

const setup = (flags: {
  readonly url: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly planOnly: boolean;
  readonly yes: boolean;
  readonly resume: boolean;
  readonly dir: Option.Option<string>;
  readonly github: Option.Option<string>;
  readonly remote: Option.Option<string>;
  readonly relay: boolean;
  readonly models: boolean;
}) =>
  Effect.gen(function* () {
    const home = process.env["HOME"] ?? "";
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* readProgress(home);
    const unfinished = Option.filter(previous, (p) => p.finishedAt === null);
    if (flags.resume && Option.isNone(unfinished))
      return yield* Effect.fail("there is no unfinished setup to resume");
    if (!flags.resume && !flags.planOnly && Option.isSome(unfinished)) {
      const p = unfinished.value;
      return yield* Effect.fail(
        `an earlier setup stopped${p.failed ? ` at ${p.failed.step} (${p.failed.why})` : ""}; run \`t3-fleet setup --resume\` to continue it`,
      );
    }
    const resumed = Option.getOrNull(flags.resume ? unfinished : Option.none<Progress>());

    // 1. Pre-flight.
    const pre = yield* preflight;
    if (pre.checks.some((c) => c.severity === "error")) {
      yield* Console.log(
        pre.checks.map((c) => `${mark(c)} ${c.title}${c.detail ? `  ${c.detail}` : ""}`).join("\n"),
      );
      return yield* Effect.fail("pre-flight failed; fix what is marked ✗ and run setup again");
    }

    // Which kind of run this is.
    const config = yield* loadConfig.pipe(Effect.option);
    const url = resumed?.url ?? Option.getOrNull(flags.url);
    const mode: Mode =
      resumed?.mode ?? (Option.isSome(config) ? "again" : url !== null ? "join" : "first");
    if (mode === "again" && url !== null && resumed === null)
      yield* Console.log(
        `This machine is already set up (${Option.isSome(config) ? config.value.repo : ""}); comparing it with its own fleet, not ${url}.`,
      );

    // The fleet to plan against: none, a fresh clone, or this machine's checkout.
    let checkout = resumed?.checkout ?? "";
    let clone: string | null = null;
    let fleet: FleetView = EMPTY_FLEET;
    let node = resumed?.node ?? Option.getOrNull(flags.name) ?? "";
    let authority = mode === "first";
    if (mode === "again" && Option.isSome(config)) {
      checkout = config.value.repo;
      node = config.value.self;
      authority =
        config.value.nodes.find((n) => n.name === node)?.roles.includes("authority") ?? false;
      fleet = yield* readFleet(checkout, node);
    }
    if (mode === "join" && url !== null) {
      yield* ensureGitConfig;
      const done = resumed?.done ?? [];
      const source = done.includes("clone")
        ? checkout
        : path.join(stateDir(home), "setup", "clone");
      if (!done.includes("clone")) {
        yield* exec({ command: "rm", args: ["-rf", source], timeout: Duration.seconds(30) });
        yield* exec({
          command: "mkdir",
          args: ["-p", path.dirname(source)],
          timeout: Duration.seconds(5),
        });
        const cloned = yield* git(home, ["clone", "-q", url, source], {
          timeout: Duration.minutes(5),
        });
        if (!ok(cloned))
          return yield* Effect.fail(`cloning ${url}: ${why(cloned)} (for GitHub: gh auth login)`);
        clone = source;
      }
      if (node === "")
        node = nodeName(
          (yield* exec({ command: "hostname", timeout: Duration.seconds(5) })).stdout.trim(),
        );
      fleet = yield* readFleet(source, node);
      if (checkout === "") {
        const probe = yield* loadConfigFrom(source, node).pipe(Effect.option);
        const fromFleet = Option.isSome(probe) ? probe.value.checkout : "~/fleet";
        checkout = path.resolve(
          expandHome(
            Option.getOrElse(flags.dir, () => fromFleet),
            home,
          ),
        );
        authority =
          Option.isSome(probe) &&
          (probe.value.nodes.find((n) => n.name === node)?.roles.includes("authority") ?? false);
      }
    }

    // 2. Discover.
    const found = yield* discover({
      taken: fleet.secretNames,
      managed: mode === "again" || resumed !== null ? checkout : null,
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

    // 3. Plan.
    const plan = buildPlan({ mode, node, authority, found, fleet });
    const paths = { home, checkout };
    const withSelf = (actions: Actions): Actions =>
      fleet.servers.has(SELF_SERVER.name) ||
      actions.servers.some((s) => s.name === SELF_SERVER.name)
        ? actions
        : { ...actions, servers: [...actions.servers, { ...SELF_SERVER, scope: "fleet" }] };
    const remote =
      mode !== "first"
        ? ""
        : Option.isSome(flags.remote)
          ? `push to ${flags.remote.value}`
          : Option.isSome(flags.github) || pre.github !== null
            ? `gh repo create ${Option.getOrElse(flags.github, () => `${pre.github}/t3-fleet`)} --private`
            : "local only for now: gh is not signed in (gh auth login), and no --remote was given";
    const fleetHasRelay =
      mode !== "first" &&
      (yield* readFleetRelay(mode === "join" && clone !== null ? clone : checkout));
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
    const nothing =
      mode === "again" &&
      plan.add.skills.length + plan.add.servers.length + plan.add.instructions.length === 0 &&
      plan.same.skills.length + plan.same.instructions.length === 0 &&
      plan.conflicts.length === 0 &&
      plan.missing.length === 0;
    if (resumed === null) {
      yield* Console.log(
        renderPlan(plan, withSelf(decide(plan, {}, paths)), {
          checkout,
          home,
          pre,
          found,
          remote,
          extras: nothing ? [] : offers,
        }),
      );
      if (nothing) {
        yield* Console.log(
          "\nNothing here differs from the fleet. `t3-fleet status` checks everything else.",
        );
        return;
      }
      if (plan.blocked.length > 0) return yield* Effect.fail("setup cannot go ahead (see above)");
      if (flags.planOnly) {
        yield* Console.log("\n--plan: nothing was written.");
        if (clone !== null)
          yield* exec({ command: "rm", args: ["-rf", clone], timeout: Duration.seconds(30) });
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
          return;
      }
    } else
      yield* Console.log(
        `Resuming setup of ${node} (${MODE_LINE[mode]}), done: ${resumed.done.join(", ") || "nothing yet"}`,
      );

    // 4. Resolve.
    const choices: Record<string, Choice> = {
      ...(resumed?.choices as Record<string, Choice> | undefined),
    };
    const missingValues: Array<Secret> = [];
    if (resumed === null) {
      for (const c of plan.conflicts) {
        if (flags.yes) continue;
        yield* Console.log(`\n${c.title}\n${c.detail}`);
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
      for (const m of plan.missing) {
        if (flags.yes || !interactive()) continue;
        const value = yield* ask(
          Prompt.Password({ message: `${m.name} (${m.why}); empty to set it later` }),
        );
        const text = Redacted.value(value);
        if (text !== "")
          missingValues.push({ name: m.name, value: text, where: "entered during setup" });
      }
    }

    // 6. Optional extras.
    const extras = yield* chooseExtras({ flags, resumed, offers, found, mode });

    const decided = decide(plan, choices, paths);
    const saved = resumed?.actions as Actions | undefined;
    const actions: Actions =
      saved !== undefined
        ? saved
        : withSelf({ ...decided, secrets: [...decided.secrets, ...missingValues] });
    const input: SetupInput = {
      mode,
      node,
      checkout,
      join:
        mode === "join" && url !== null
          ? { url, clone: clone ?? path.join(stateDir(home), "setup", "clone") }
          : null,
      commits: plan.commits,
      actions,
      extras,
      timer: pre.timer,
      remote:
        mode !== "first"
          ? null
          : Option.isSome(flags.remote)
            ? { url: flags.remote.value }
            : Option.isSome(flags.github)
              ? { github: flags.github.value }
              : pre.github !== null
                ? { github: `${pre.github}/t3-fleet` }
                : null,
      raw: found.raw,
      now,
    };

    // 5. Apply, step by step.
    let progress: Progress = resumed ?? {
      startedAt: now,
      mode,
      node,
      checkout,
      url,
      choices,
      extras: { relay: extras.relay !== null, models: extras.models !== null, t3: extras.t3 },
      done: [],
      failed: null,
      finishedAt: null,
    };
    yield* writeProgress(home, progress);
    const steps = setupSteps(input, {
      t3Connect: connectT3.pipe(Effect.map((lines) => lines.join("; "))),
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
          `setup stopped at "${step.id}"; fix that, then: t3-fleet setup --resume`,
        );
      }
      yield* Console.log(
        `✓ ${step.title}${result.success.length > 0 ? `\n    ${result.success.join("\n    ")}` : ""}`,
      );
      progress = {
        ...progress,
        done: [...progress.done, step.id],
        failed: null,
        ...(step.id === "keys" ? { actions: withoutValues(actions) } : {}),
      };
      yield* writeProgress(home, progress);
    }
    if (plan.commits && mode === "again") {
      const merged = yield* mergeProposedSecrets(checkout).pipe(
        Effect.orElseSucceed(() => [] as Array<string>),
      );
      for (const line of merged) yield* Console.log(`✓ ${line}`);
    }
    yield* writeProgress(home, { ...progress, finishedAt: yield* Clock.currentTimeMillis });

    yield* Console.log(`\n${node} is set up.`);
    if (mode === "first") {
      if (input.remote === null)
        yield* Console.log(
          `Push the repo to a private repository, then add machines:\n  git -C ${tilde(checkout, home)} remote add origin <url> && git -C ${tilde(checkout, home)} push -u origin main`,
        );
      yield* Console.log(
        "Add another machine: t3-fleet invite <name>, then run what it prints there.",
      );
    } else if (!plan.commits) {
      const proposed =
        actions.skills.length +
        actions.servers.length +
        actions.instructions.length +
        secretsToStore(input).length;
      if (proposed > 0)
        yield* Console.log(
          `What this machine adds is proposed: on an authority, t3-fleet review, then t3-fleet approve ${node}.`,
        );
      const recipients = yield* readRecipients(checkout);
      if (recipients[node] === undefined)
        yield* Console.log(
          "An authority's next sync adds this machine's key; then it reads the fleet's secrets.",
        );
    }
  });

/** Whether the fleet's t3-fleet.toml already has a relay. */
const readFleetRelay = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(`${repo}/${FLEET_FILE}`)
      .pipe(Effect.orElseSucceed(() => ""));
    return /^\[relay\]/m.test(text);
  });

const chooseExtras = (input: {
  readonly flags: { readonly yes: boolean; readonly relay: boolean; readonly models: boolean };
  readonly resumed: Progress | null;
  readonly offers: ReadonlyArray<readonly [string, string]>;
  readonly found: Discovery;
  readonly mode: Mode;
}) =>
  Effect.gen(function* () {
    const offered = (name: string) => input.offers.some(([n]) => n === name);
    const want = (name: string, flag: boolean, why: string, initial: boolean) =>
      Effect.gen(function* () {
        if (!offered(name)) return false;
        if (input.resumed !== null)
          return (
            input.resumed.extras[
              name === "model proxy" ? "models" : name === "T3 access" ? "t3" : name
            ] === true
          );
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
