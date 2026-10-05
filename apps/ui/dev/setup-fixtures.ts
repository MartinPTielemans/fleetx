/**
 * The setup wizard's half of the fixtures: a machine not in a fleet yet,
 * a hub to probe, a plan, and apply jobs that run through their steps on
 * timers and stream as "job" events, so every screen can be clicked through
 * without a server. Typed against SetupApi.ts.
 *
 * Pick a variant with the page's query string (the fixtures read it from the
 * Referer), and open it with #ticket=f, which starts it over:
 *
 *   ?setup=fresh        a new machine (no setup param: a fleet member, the usual fixtures)
 *   ?setup=nogh         the same, without a GitHub sign-in
 *   ?setup=preflight    a pre-flight error that blocks setup
 *   ?setup=unfinished   a setup that stopped part-way: resume or abandon
 *   ?setup=hubfailed    in the fleet, but the hub's bring-up failed: retry or forget it
 *   &apply=fail         the run stops at "Commit and push" (resume continues it)
 *   &apply=hubfail      this computer's part works, the hub's stops
 *   &apply=stale        apply refuses the first plan as out of date (409 stale-plan)
 *   &apply=refuse       apply refuses with a reason (422), not a stale plan
 *   &replan=fail        the first plan is made; every one after it fails (422)
 *   &expire=1           a finished job is dropped a second later, as keepJobsFor
 *                       does: reload after the run to see the page read the state
 *   &probe=ready|missing|old|taken|unreachable|local   the hub probe's answer; without
 *                       it, the ssh destination decides: "…down…" or "…nope…" is
 *                       unreachable, "…bare…" lacks tailscale and docker,
 *                       "…old…" has Node 20, "…local…" is a Mac whose tailscaled
 *                       runs as a user (the app then opens locally), anything
 *                       else is ready
 *   &fast=1             apply steps every 150ms instead of 900ms
 */
import type { UiJob, UiSession } from "@t3-fleet/core/Api";
import {
  SETUP_ERROR_HEADER,
  STALE_PLAN,
  type UiPlanConflict,
  type UiProbe,
  type UiProbeItem,
  type UiSetupApplyRequest,
  type UiSetupPlan,
  type UiSetupPlanRequest,
  type UiSetupState,
} from "@t3-fleet/core/SetupApi";
import { hubStepTitles, mcpHubLine, settingsWords } from "@t3-fleet/core/setup/PlanWords";
import { NTFY_SECRET } from "@t3-fleet/core/Upkeep";

type Answer = {
  status: number;
  body: string;
  delay?: number;
  headers?: Readonly<Record<string, string>>;
};
const json = (value: unknown, delay = 0): Answer => ({
  status: 200,
  body: JSON.stringify(value),
  delay,
});

const HOUR = 3_600_000;

// ── one simulated machine per variant ───────────────────────────────────

interface Sim {
  stage: UiSetupState["stage"];
  unfinished: UiSetupState["unfinished"];
  github: string | null;
  jobs: Map<string, UiJob>;
  streams: Set<(chunk: string) => void>;
  lastPlan: { request: UiSetupPlanRequest; plan: UiSetupPlan } | null;
  /** Where the run stopped: which job and step to continue from. */
  stopped: { kind: "setup" | "setup-hub"; at: number } | null;
  /** The hub's part already failed once (hubfail): the retry works. */
  failedOnce: boolean;
  /** A hub asked for and not brought up yet, with why the last try stopped. */
  hub: UiSetupState["hub"];
  /** How many plans were made (replan=fail fails all but the first). */
  plans: number;
  /** Apply refused a plan as stale once already (apply=stale). */
  staleOnce: boolean;
  /** Finished jobs are dropped a second after (expire=1). */
  expire: boolean;
}

const sims = new Map<string, Sim>();
const keyOf = (page: URLSearchParams) =>
  ["setup", "apply", "replan", "expire"].map((k) => `${k}=${page.get(k) ?? ""}`).join("&");

const fresh = (page: URLSearchParams): Sim => {
  const variant = page.get("setup");
  return {
    stage: variant === "unfinished" ? "unfinished" : variant === "hubfailed" ? "member" : "fresh",
    unfinished:
      variant === "unfinished" ? { startedAt: Date.now() - 2 * HOUR, done: 4, total: 9 } : null,
    github: variant === "nogh" ? null : "octo",
    jobs: new Map(),
    streams: new Set(),
    lastPlan: null,
    stopped:
      variant === "unfinished"
        ? { kind: "setup", at: 4 }
        : variant === "hubfailed"
          ? { kind: "setup-hub", at: 0 }
          : null,
    failedOnce: false,
    hub:
      variant === "hubfailed"
        ? { node: "box", ssh: "me@box", error: HUB_ERROR }
        : variant === "unfinished"
          ? { node: "box", ssh: "me@box", error: null }
          : null,
    plans: 0,
    staleOnce: false,
    expire: page.get("expire") === "1",
  };
};

const simOf = (page: URLSearchParams) => {
  const key = keyOf(page);
  const known = sims.get(key);
  if (known !== undefined) return known;
  const made = fresh(page);
  sims.set(key, made);
  return made;
};

const emit = (sim: Sim, job: UiJob) => {
  sim.jobs.set(job.id, job);
  const chunk = `event: job\ndata: ${JSON.stringify(job)}\n\n`;
  for (const write of sim.streams) write(chunk);
  if (sim.expire && (job.state === "done" || job.state === "failed"))
    setTimeout(() => sim.jobs.delete(job.id), 1000);
};

/** Whether this page asks for the wizard at all: without ?setup the fixtures are a fleet. */
export const inSetup = (page: URLSearchParams) => page.has("setup");

// ── what the machine has ────────────────────────────────────────────────

const checksFor = (variant: string | null, github: string | null): UiSetupState["checks"] => [
  variant === "preflight"
    ? {
        key: "node",
        severity: "error",
        title: "Node 20.11.0 is too old",
        detail: "brew install node@24",
      }
    : { key: "node", severity: "ok", title: "Node 24.13.1", detail: null },
  { key: "git", severity: "ok", title: "git 2.50.1", detail: null },
  github === null
    ? {
        key: "gh",
        severity: "info",
        title: "GitHub CLI not signed in",
        detail: "Optional: it creates the fleet's private repository. Sign in with gh auth login.",
      }
    : { key: "gh", severity: "ok", title: `GitHub: ${github}`, detail: null },
  variant === "preflight"
    ? {
        key: "path",
        severity: "warn",
        title: "~/.local/bin is not on PATH",
        detail:
          "T3 Fleet installs its command there. Add it to PATH in ~/.zshrc, or setup does it for this shell's profile.",
      }
    : { key: "path", severity: "ok", title: "~/.local/bin on PATH", detail: null },
  { key: "timer", severity: "ok", title: "launchd runs the sync timer", detail: null },
];

const stateOf = (sim: Sim, page: URLSearchParams): UiSetupState => ({
  stage: sim.stage,
  hostname: "mbp-14.local",
  suggestedName: "mbp-14",
  checks: checksFor(page.get("setup"), sim.github),
  github: sim.github,
  unfinished: sim.stage === "unfinished" ? sim.unfinished : null,
  hub: sim.hub,
  // Once the hub is up it serves the fleet's app on the tailnet, unless it cannot.
  fleetUrl:
    sim.stage === "member" &&
    sim.hub === null &&
    sim.lastPlan?.plan.hub != null &&
    probeKind(sim.lastPlan.request.hub?.ssh ?? "", page) !== "local"
      ? `https://${HUB_HOST}`
      : null,
});

// ── the hub ─────────────────────────────────────────────────────────────

const HUB_HOST = "box.tailnet.ts.net";

const ok = (label: string): UiProbeItem => ({ state: "ok", label, remedy: null });

const probeKind = (ssh: string, page: URLSearchParams) =>
  page.get("probe") ??
  (/down|nope|unreachable/.test(ssh)
    ? "unreachable"
    : /bare|missing/.test(ssh)
      ? "missing"
      : /old/.test(ssh)
        ? "old"
        : /local/.test(ssh)
          ? "local"
          : "ready");

const probeFor = (ssh: string, page: URLSearchParams): UiProbe => {
  const kind = probeKind(ssh, page);
  const host = HUB_HOST;
  if (kind === "unreachable") {
    const unknown: UiProbeItem = { state: "unknown", label: "", remedy: null };
    return {
      ssh,
      reachable: false,
      error: `ssh: connect to host ${ssh.replace(/^.*@/, "")} port 22: Operation timed out`,
      hostname: null,
      os: null,
      node: unknown,
      git: unknown,
      t3: unknown,
      tailscale: unknown,
      docker: unknown,
      service: unknown,
      fleet: unknown,
      relayUrl: null,
      ready: false,
    };
  }
  const bare = kind === "missing";
  return {
    ssh,
    reachable: true,
    error: null,
    hostname: host,
    os: kind === "local" ? "Darwin" : "Ubuntu 24.04 · x86_64",
    node:
      kind === "old"
        ? {
            state: "missing",
            label: "Node 20.11.0, needs 24 or newer",
            remedy: "curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24",
          }
        : ok("Node 24.13.1"),
    git: ok("git 2.43.0"),
    t3: ok("T3 Code 0.0.46 nightly"),
    tailscale: bare
      ? {
          state: "missing",
          label: "tailscale not installed",
          remedy: "curl -fsSL https://tailscale.com/install.sh | sh",
        }
      : ok(`tailscale: ${host}`),
    docker: bare
      ? {
          state: "warn",
          label: "docker installed, not running",
          remedy: "sudo systemctl enable --now docker",
        }
      : ok("docker 27.3.1, running"),
    service: ok("systemd, with lingering"),
    fleet:
      kind === "taken"
        ? {
            state: "missing",
            label: "Already in another fleet: github.com/someone/their-fleet",
            remedy:
              "It is already in another fleet (github.com/someone/their-fleet), as box. Take it out of that fleet first (t3-fleet leave on it), or choose another machine for the hub.",
          }
        : ok("In no fleet yet"),
    app:
      kind === "local"
        ? {
            state: "warn",
            label:
              "The fleet app will open locally on this computer instead: tailscaled runs as a user on the hub, so it cannot tell tailscale serve from other programs",
            remedy:
              "To open the app from the hub, run tailscaled as root (sudo tailscaled install-system-daemon) or use the Tailscale app, then check again.",
          }
        : ok("Serves the fleet app on the tailnet"),
    relayUrl: bare ? null : `https://${host}`,
    ready: kind !== "old" && kind !== "taken",
  };
};

// ── the plan ────────────────────────────────────────────────────────────

const POSTHOG_DIFF = `--- Claude's
+++ Codex's
@@ -1,9 +1,10 @@
 {
   "type": "stdio",
   "command": "npx",
   "args": [
     "-y",
-    "@posthog/mcp-server@0.9.2"
+    "@posthog/mcp-server@latest",
+    "--region=eu"
   ],
   "env": {
     "POSTHOG_API_KEY": "\${POSTHOG_API_KEY}"
   }
 }`;

const TDD_DIFF = `--- ~/.claude/skills/tdd/SKILL.md
+++ ~/.codex/skills/tdd/SKILL.md
@@ -1,8 +1,7 @@
 ---
 name: tdd
-description: Test-driven development. Use when building features or fixing bugs test-first.
+description: Test-driven development.
 ---

 # Red, green, refactor

-Write the failing test first, and watch it fail for the right reason.
-Then make it pass with the least code that could work.
+Write the failing test first. Make it pass. Refactor.
@@ -21,4 +20,6 @@
 ## Integration tests

 Prefer tests that exercise the real boundary over mocks of it.
+
+When a test is slow, say so in its name.`;

const FLEET_TDD = `--- the fleet's skills/tdd/SKILL.md
+++ ~/.claude/skills/tdd/SKILL.md
@@ -3,3 +3,3 @@
 ---
-description: TDD.
+description: Test-driven development. Use when building features or fixing bugs test-first.
 ---`;

const planFor = (request: UiSetupPlanRequest, github: string | null): UiSetupPlan => {
  const join = request.repo.kind === "url";
  const remote =
    request.repo.kind === "github"
      ? `git@github.com:${github ?? "octo"}/${request.repo.name}.git`
      : request.repo.kind === "url"
        ? request.repo.url
        : null;
  const skill = (name: string, from = "~/.claude/skills", note: string | null = null) => ({
    kind: "skill" as const,
    name,
    from,
    note,
  });
  const server = (name: string, from: string, note: string | null = null) => ({
    kind: "server" as const,
    name,
    from,
    note,
  });
  const conflicts: Array<UiPlanConflict> = [
    {
      id: "server-here:posthog",
      kind: "server",
      name: "posthog",
      title: "MCP server posthog: Claude and Codex have it differently",
      detail: POSTHOG_DIFF,
      choices: [
        { value: "copy:0", label: "use Claude's" },
        { value: "copy:1", label: "use Codex's" },
      ],
      default: "copy:0",
      after: null,
    },
    {
      id: "skill-here:tdd",
      kind: "skill",
      name: "tdd",
      title: "skill tdd: 2 different copies on this machine",
      detail: TDD_DIFF,
      choices: [
        { value: "copy:0", label: "use ~/.claude/skills/tdd (newest, edited 3 days ago)" },
        { value: "copy:1", label: "use ~/.codex/skills/tdd" },
      ],
      default: "copy:0",
      after: null,
    },
  ];
  if (join)
    conflicts.push({
      id: "skill:tdd",
      kind: "skill",
      name: "tdd",
      title: "skill tdd: the copy chosen above is not the fleet's",
      detail: FLEET_TDD,
      choices: [
        { value: "fleet", label: "keep the fleet's (this machine gets it)" },
        { value: "mine", label: "propose this machine's to the fleet" },
      ],
      default: "fleet",
      after: "skill-here:tdd",
      byChoice: { "copy:0": FLEET_TDD, "copy:1": null },
    });
  const extras = request.extras.map((e) =>
    e === "model proxy"
      ? "Set up the model proxy for Claude and Codex"
      : "Give T3 Fleet read-only access to T3",
  );
  return {
    planId: `fx-plan-${Date.now()}`,
    mode: join ? "join" : "first",
    node: request.node,
    commits: !join,
    repo: { path: "~/fleet", remote },
    add: [
      skill("code-review"),
      skill("diagnosing-bugs"),
      skill("domain-modeling"),
      skill("frontend-design", "~/.claude/skills", "from github.com/anthropics/skills"),
      skill("grilling"),
      skill("research", "~/.codex/skills"),
      skill("tdd"),
      skill("writing-for-agents"),
      server("linear", "Claude Code"),
      server("playwright", "Claude Code", "on this machine only: needs a display"),
      server("posthog", "Claude Code and Codex"),
      server("github", "Codex"),
      server("context7", "Claude Code"),
      {
        kind: "instruction" as const,
        name: "AGENTS.md",
        from: "~/AGENTS.md",
        note: "linked as CLAUDE.md too",
      },
    ].filter((i) => !join || !["code-review", "linear"].includes(i.name)),
    same: join
      ? [
          skill("code-review"),
          server("linear", "Claude Code"),
          skill("grilling", "~/.codex/skills"),
        ]
      : [],
    conflicts,
    leftAlone: [
      {
        item: server("sentry-dev", "Claude project ~/code/app"),
        why: "a Claude project's server, not yours to share",
      },
      { item: skill("scratch"), why: "ignored by the fleet's [skills] ignore" },
      // Agent CLIs come as servers for now: the screen must not call them one.
      {
        item: server("claude", "~/.local/bin/claude"),
        why: "an agent CLI: T3 Fleet keeps it current on each machine, not in the repo",
      },
    ],
    secrets: [
      { name: "POSTHOG_API_KEY", server: "posthog", from: "Claude Code env" },
      { name: "LINEAR_API_KEY", server: "linear", from: "Codex config" },
      { name: "CONTEXT7_API_KEY", server: "context7", from: "Claude Code env" },
      // As the engine lists it: by name, never the topic.
      ...(request.notify.ntfy === null
        ? []
        : [{ name: NTFY_SECRET, server: "notifications", from: "the ntfy topic setup made" }]),
    ],
    missing: [
      {
        name: "GITHUB_PERSONAL_ACCESS_TOKEN",
        why: "The github server reads it from its environment; neither Claude nor Codex had it set.",
      },
    ],
    hub:
      request.hub === null
        ? null
        : {
            node: request.hub.node,
            ssh: request.hub.ssh,
            relayUrl: `https://${HUB_HOST}`,
            mcp: request.hub.mcp,
            ...(request.hub.mcp
              ? {
                  servers: [
                    { name: "context7", hub: true, why: null },
                    { name: "posthog", hub: true, why: null },
                    {
                      name: "github",
                      hub: false,
                      why: "it runs a command on each machine, and the hub runs only containers and commands declared for it",
                    },
                    {
                      name: "t3-fleet",
                      hub: false,
                      why: "it runs a command on each machine, and the hub runs only containers and commands declared for it",
                    },
                  ],
                }
              : {}),
            steps: hubStepTitles(request.hub),
          },
    // The engine's words (setup/PlanWords.ts); a fleet joined keeps its own [fleet] apply.
    settings: [
      ...(request.hub?.mcp === true ? [mcpHubLine(request.hub.node)] : []),
      ...settingsWords({
        node: request.node,
        mcpHub: false,
        autoUpdate: join ? null : request.autoUpdate,
        desktop: request.notify.desktop,
        ntfy: request.notify.ntfy !== null,
      }),
    ],
    steps: [
      "Snapshot the clients' MCP servers",
      join
        ? `Clone the fleet from ${remote ?? ""}`
        : request.repo.kind === "github"
          ? `Create the private repository ${github ?? "octo"}/${request.repo.name}`
          : "Create the fleet's repository at ~/fleet",
      join
        ? "Write what this machine brings into ~/fleet"
        : "Write skills, MCP servers, instructions and settings into the repo",
      "Make this machine's key and store 3 secrets",
      join ? "Propose them to the fleet" : remote === null ? "Commit them" : "Commit and push",
      "Write ~/.config/t3-fleet/config.toml",
      "Link skills and instructions from the repo",
      ...extras,
      "Install the sync timer",
      "Run a first sync",
    ],
  };
};

// ── apply, as jobs on timers ────────────────────────────────────────────

const HUB_ERROR =
  "ssh box: systemctl --user enable --now t3-fleet-listen: Failed to connect to bus: No medium found (lingering is off for this user; run sudo loginctl enable-linger $USER on box)";

const ERRORS = {
  setup:
    "git push origin main: remote: Repository not found.\nfatal: could not read from remote repository. Is gh still signed in as octo?",
  "setup-hub": HUB_ERROR,
} as const;

const runSteps = (
  sim: Sim,
  page: URLSearchParams,
  kind: "setup" | "setup-hub",
  title: string,
  steps: ReadonlyArray<string>,
  from: number,
  failAt: number | null,
  then: () => void,
): UiJob => {
  const tick = page.get("fast") === "1" ? 150 : 900;
  let job: UiJob = {
    id: `fx-${kind}-${Date.now()}`,
    kind,
    title,
    state: "running",
    step: "starting",
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    applied: null,
    landed: null,
  };
  emit(sim, job);
  let i = from;
  const next = () => {
    if (i === failAt) {
      job = { ...job, state: "failed", step: null, finishedAt: Date.now(), error: ERRORS[kind] };
      sim.stopped = { kind, at: i };
      if (kind === "setup-hub" && sim.hub !== null) {
        // This computer is in the fleet already; only the hub is left.
        sim.hub = { ...sim.hub, error: ERRORS[kind] };
        emit(sim, job);
        return;
      }
      sim.stage = "unfinished";
      sim.unfinished = {
        startedAt: job.startedAt,
        done: (kind === "setup" ? 0 : (sim.lastPlan?.plan.steps.length ?? 0)) + i,
        total: (sim.lastPlan?.plan.steps.length ?? 9) + (sim.lastPlan?.plan.hub?.steps.length ?? 0),
      };
      emit(sim, job);
      return;
    }
    if (i >= steps.length) {
      job = { ...job, state: "done", step: null, finishedAt: Date.now() };
      emit(sim, job);
      then();
      return;
    }
    job = { ...job, step: steps[i] ?? null };
    emit(sim, job);
    i++;
    setTimeout(next, tick * (0.7 + ((i * 37) % 10) / 10));
  };
  setTimeout(next, tick / 2);
  return job;
};

const startHub = (sim: Sim, page: URLSearchParams, from: number): UiJob | null => {
  // As the server does: in the fleet once this computer's part is done, said with "session".
  becomeMember(sim);
  const hub =
    sim.lastPlan?.plan.hub ??
    (sim.hub === null ? null : { node: sim.hub.node, steps: hubStepTitles(sim.hub) });
  if (hub == null) return null;
  if (sim.hub !== null) sim.hub = { ...sim.hub, error: null };
  const fail = page.get("apply") === "hubfail" && !sim.failedOnce ? 2 : null;
  if (fail !== null) sim.failedOnce = true;
  return runSteps(
    sim,
    page,
    "setup-hub",
    `Set up ${hub.node} as the hub`,
    hub.steps,
    from,
    fail,
    () => {
      sim.hub = null;
    },
  );
};

const becomeMember = (sim: Sim) => {
  if (sim.stage === "member") return;
  sim.stage = "member";
  sim.stopped = null;
  sim.unfinished = null;
  const session: UiSession = {
    version: "0.10.0",
    self: "mbp-14",
    authority: true,
    nodes: sim.hub === null ? ["mbp-14"] : ["mbp-14", sim.hub.node],
    relay: null,
  };
  const chunk = `event: session\ndata: ${JSON.stringify(session)}\n\n`;
  for (const write of sim.streams) write(chunk);
};

const apply = (sim: Sim, page: URLSearchParams, request: UiSetupApplyRequest): Answer => {
  if (request.kind === "abandon") {
    // In the fleet, abandoning forgets the hub still to bring up; before it, the whole run.
    const report =
      sim.stage === "member"
        ? []
        : [
            "Dropped the unfinished setup of mbp-14. What it did stays:",
            "  ✓ snapshot of the clients' MCP servers (for t3-fleet leave)",
            "  ✓ created the private repository octo/fleet",
            "  ✓ wrote skills, MCP servers and instructions into ~/fleet",
            "  ✓ made this machine's key, and stored 3 secrets",
            "Not done: commit, config, links, timer, sync.",
            "To finish it: run `t3-fleet setup` again. It publishes what this run wrote and runs the first sync, which registers its servers, then shows anything else that still differs.",
            "To undo it instead:",
            "  `git -C ~/fleet status -- skills mcp AGENTS.md` shows what it wrote; `git -C ~/fleet checkout -- <file>` puts a changed file back, and a new one can be deleted",
          ];
    if (sim.hub !== null)
      report.push(
        `Forgot bringing up ${sim.hub.node} as the hub; what was done there stays. To add a hub later, run \`t3-fleet setup <repository> <name> --relay\` on it.`,
      );
    if (sim.stage !== "member") sim.stage = "fresh";
    sim.stopped = null;
    sim.unfinished = null;
    sim.hub = null;
    return json({ jobId: null, report }, 400);
  }
  const steps =
    sim.lastPlan?.plan.steps ??
    planFor(
      {
        repo: { kind: "github", name: "fleet" },
        node: "mbp-14",
        hub: null,
        extras: [],
        autoUpdate: true,
        notify: { desktop: true, ntfy: null },
      },
      sim.github,
    ).steps;
  if (request.kind === "resume") {
    const stopped = sim.stopped ?? { kind: "setup" as const, at: 0 };
    sim.stopped = null;
    if (sim.stage !== "member") sim.stage = "unfinished";
    if (stopped.kind === "setup-hub") {
      const job = startHub(sim, page, stopped.at);
      return json({ jobId: job?.id ?? null });
    }
    const job = runSteps(sim, page, "setup", "Set up this computer", steps, stopped.at, null, () =>
      startHub(sim, page, 0),
    );
    return json({ jobId: job.id });
  }
  const stale = page.get("apply") === "stale" && !sim.staleOnce;
  if (stale) sim.staleOnce = true;
  if (stale || sim.lastPlan === null || sim.lastPlan.plan.planId !== request.planId)
    return {
      status: 409,
      body: "this machine or the fleet changed since the plan was made: plan again, and review what changed",
      headers: { [SETUP_ERROR_HEADER]: STALE_PLAN },
    };
  if (page.get("apply") === "refuse")
    return {
      status: 422,
      body: "~/fleet already exists and is not empty; move it aside (or, from a terminal, choose another place with `t3-fleet setup --dir <path>`)",
    };
  const hub = sim.lastPlan.plan.hub;
  sim.hub = hub === null ? null : { node: hub.node, ssh: hub.ssh, error: null };
  const job = runSteps(
    sim,
    page,
    "setup",
    "Set up this computer",
    steps,
    0,
    page.get("apply") === "fail" ? 5 : null,
    () => startHub(sim, page, 0),
  );
  return json({ jobId: job.id }, 300);
};

// ── the endpoints ───────────────────────────────────────────────────────

/** The setup endpoints' answers, or null for a path that is not setup's. */
export const setupResponse = (
  method: string,
  path: string,
  body: string,
  page: URLSearchParams,
): Answer | null => {
  if (path === "/api/session" && method === "POST") {
    // A new tab from the link: the variant starts over.
    sims.set(keyOf(page), fresh(page));
    return null;
  }
  if (!path.startsWith("/api/setup/")) return null;
  if (!inSetup(page)) {
    if (path === "/api/setup/state")
      return json({ ...stateOf(fresh(page), page), stage: "member" } satisfies UiSetupState);
    if (path === "/api/setup/invite") return invite(body, null);
    return { status: 404, body: "this machine is in a fleet" };
  }
  const sim = simOf(page);
  switch (path) {
    case "/api/setup/state":
      return json(stateOf(sim, page), 120);
    case "/api/setup/probe": {
      const { ssh } = JSON.parse(body) as { ssh: string };
      return json(probeFor(ssh, page), 1400);
    }
    case "/api/setup/plan": {
      const request = JSON.parse(body) as UiSetupPlanRequest;
      sim.plans++;
      if (page.get("replan") === "fail" && sim.plans > 1)
        return {
          status: 422,
          body: "could not read the fleet: git clone git@github.com:octo/fleet.git: Permission denied (publickey)",
          delay: 900,
        };
      const plan = planFor(request, sim.github);
      sim.lastPlan = { request, plan };
      return json(plan, 1100);
    }
    case "/api/setup/apply":
      return apply(sim, page, JSON.parse(body) as UiSetupApplyRequest);
    case "/api/setup/invite":
      return invite(body, sim.lastPlan?.plan.repo.remote ?? null);
    case "/api/setup/notify-test": {
      const notify = sim.lastPlan?.request.notify;
      const lines = [
        ...(notify?.desktop === true ? ["desktop: delivered"] : []),
        ...(notify?.ntfy != null ? ["ntfy: delivered"] : []),
      ];
      return json(
        { lines: lines.length > 0 ? lines : ["no [notify] paths configured"], failed: false },
        900,
      );
    }
  }
  return { status: 404, body: "no such endpoint" };
};

const invite = (body: string, remote: string | null): Answer => {
  const { node } = JSON.parse(body) as { node: string };
  return json(
    {
      command: `curl -fsSL https://github.com/MartinPTielemans/t3-fleet/releases/latest/download/install.sh | sh -s -- setup ${remote ?? "git@github.com:octo/fleet.git"} ${node}`,
    },
    350,
  );
};

/** In setup, the session has no fleet yet: no nodes, no authority. */
export const setupSession = (page: URLSearchParams, member: UiSession): UiSession | null => {
  if (!inSetup(page)) return null;
  return simOf(page).stage === "member"
    ? { ...member, self: "mbp-14", nodes: ["mbp-14"], relay: null }
    : { ...member, self: "mbp-14", authority: false, nodes: [], relay: null };
};

/** The jobs the simulated machine knows, for /api/jobs and the stream's first events. */
export const setupJobs = (page: URLSearchParams): ReadonlyArray<UiJob> =>
  inSetup(page) ? [...simOf(page).jobs.values()] : [];

/** Follow the simulated machine's jobs on an open event stream; returns how to stop. */
export const followSetup = (page: URLSearchParams, write: (chunk: string) => void) => {
  if (!inSetup(page)) return () => undefined;
  const sim = simOf(page);
  for (const job of sim.jobs.values()) write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  sim.streams.add(write);
  return () => {
    sim.streams.delete(write);
  };
};
