/**
 * The setup wizard's HTTP contract: what `t3-fleet ui` serves when this
 * machine is not in a fleet yet (or a setup stopped part-way), and what the
 * app in apps/ui/src/views/setup reads. The same engine as `t3-fleet setup`
 * (setup/Plan.ts, setup/Apply.ts) answers it; only the questions move from
 * terminal prompts to screens.
 *
 *   GET  /api/setup/state     where this machine stands, and its pre-flight
 *   POST /api/setup/probe     a candidate hub, checked over ssh (read-only)
 *   POST /api/setup/plan      everything setup would do, before anything is written
 *   POST /api/setup/apply     do it, as a job ("setup"), then the hub ("setup-hub")
 *   POST /api/setup/invite    the line another machine runs to join
 *
 * Progress comes as the existing "job" events on /api/events. A run that
 * stops part-way is "unfinished" in the state and continues with apply's
 * `resume`, doing what was decided, as `t3-fleet setup --resume` does.
 */
import * as Schema from "effect/Schema";

// ── where this machine stands ───────────────────────────────────────────

export const UiSetupCheck = Schema.Struct({
  key: Schema.String,
  /** error: setup cannot go on; warn: it can, with what the detail says. */
  severity: Schema.Literals(["ok", "info", "warn", "error"]),
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
export type UiSetupCheck = typeof UiSetupCheck.Type;

export const UiSetupState = Schema.Struct({
  /**
   *   fresh       not in a fleet: the wizard starts at "what do you have?"
   *   unfinished  a setup stopped part-way: resume or abandon it
   *   member      already set up: the app shows the fleet, not the wizard
   */
  stage: Schema.Literals(["fresh", "unfinished", "member"]),
  hostname: Schema.String,
  /** The node name setup would give this machine. */
  suggestedName: Schema.String,
  checks: Schema.Array(UiSetupCheck),
  /** The GitHub account gh is signed in to, for "create a private repo"; null without one. */
  github: Schema.NullOr(Schema.String),
  /** What the stopped run was doing, when stage is "unfinished". */
  unfinished: Schema.NullOr(
    Schema.Struct({ startedAt: Schema.Number, done: Schema.Number, total: Schema.Number }),
  ),
});
export type UiSetupState = typeof UiSetupState.Type;

// ── the hub, checked from here ──────────────────────────────────────────

export const UiProbeRequest = Schema.Struct({
  /** An ssh destination: "server", "me@box.tailnet.ts.net". */
  ssh: Schema.String,
});

/** One thing the hub needs, as found there. */
export const UiProbeItem = Schema.Struct({
  state: Schema.Literals(["ok", "missing", "warn", "unknown"]),
  /** "Node 24.13.1", "tailscale: box.tailnet.ts.net", "docker not running". */
  label: Schema.String,
  /** What to do about it, when not ok: a command or a sentence. */
  remedy: Schema.NullOr(Schema.String),
});
export type UiProbeItem = typeof UiProbeItem.Type;

export const UiProbe = Schema.Struct({
  ssh: Schema.String,
  reachable: Schema.Boolean,
  /** Why it could not be reached (host key, auth, timeout), in words. */
  error: Schema.NullOr(Schema.String),
  hostname: Schema.NullOr(Schema.String),
  os: Schema.NullOr(Schema.String),
  node: UiProbeItem,
  git: UiProbeItem,
  t3: UiProbeItem,
  /** Other machines reach the relay over the tailnet. */
  tailscale: UiProbeItem,
  /** The MCP hub runs container servers with it. */
  docker: UiProbeItem,
  /** A service manager that keeps the relay running (systemd, launchd). */
  service: UiProbeItem,
  /** The relay URL setup would use, when tailscale gives one. */
  relayUrl: Schema.NullOr(Schema.String),
  /** Whether everything required is there; tailscale and docker are recommended, not required. */
  ready: Schema.Boolean,
});
export type UiProbe = typeof UiProbe.Type;

// ── the plan ────────────────────────────────────────────────────────────

export const UiSetupRepo = Schema.Union([
  /** A new private repository on the signed-in GitHub account. */
  Schema.Struct({ kind: Schema.Literal("github"), name: Schema.String }),
  /** An existing remote: joining a fleet, or a repo made by hand. */
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  /** Only a local repository, no remote yet. */
  Schema.Struct({ kind: Schema.Literal("local") }),
]);
export type UiSetupRepo = typeof UiSetupRepo.Type;

export const UiSetupPlanRequest = Schema.Struct({
  repo: UiSetupRepo,
  /** This machine's node name. */
  node: Schema.String,
  /** The always-on machine to make the relay and MCP hub, checked first with probe; null for none. */
  hub: Schema.NullOr(Schema.Struct({ ssh: Schema.String, node: Schema.String })),
  /** Extras chosen (setup/Extras.ts names); the relay is implied by a hub. */
  extras: Schema.Array(Schema.Literals(["model proxy", "T3 access"])),
});
export type UiSetupPlanRequest = typeof UiSetupPlanRequest.Type;

/** A skill, server or instruction file, as one row on the plan screen. */
export const UiPlanItem = Schema.Struct({
  kind: Schema.Literals(["skill", "server", "instruction"]),
  name: Schema.String,
  /** Where it was found: "~/.claude/skills", "Claude Code", "~/AGENTS.md". */
  from: Schema.String,
  /** Extra words: "on this machine only: needs docker", a source URL. */
  note: Schema.NullOr(Schema.String),
});
export type UiPlanItem = typeof UiPlanItem.Type;

export const UiPlanConflict = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["skill", "server", "instruction"]),
  name: Schema.String,
  title: Schema.String,
  /** A unified diff (lines starting "+", "-", " ", "@@"), or two definitions. */
  detail: Schema.String,
  choices: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
  default: Schema.String,
  /** The conflict whose choice this one follows; it applies only when that choice differs. */
  after: Schema.NullOr(Schema.String),
});
export type UiPlanConflict = typeof UiPlanConflict.Type;

export const UiPlanSecret = Schema.Struct({
  /** Its name in the encrypted secrets file: "POSTHOG_API_KEY". */
  name: Schema.String,
  /** The server it belongs to. */
  server: Schema.String,
  /** Where the value was found: "Claude Code env", "Codex config". Never the value. */
  from: Schema.String,
});

/** A credential a server needs that was not found here; asked for, or set later. */
export const UiPlanMissing = Schema.Struct({ name: Schema.String, why: Schema.String });

export const UiSetupPlan = Schema.Struct({
  /** Pass back to apply; a plan is only applied while nothing it read has changed. */
  planId: Schema.String,
  mode: Schema.Literals(["first", "join", "again"]),
  node: Schema.String,
  /** Whether this machine commits (first, or an authority) rather than proposes. */
  commits: Schema.Boolean,
  /** "~/fleet", and its remote when there is one. */
  repo: Schema.Struct({ path: Schema.String, remote: Schema.NullOr(Schema.String) }),
  add: Schema.Array(UiPlanItem),
  same: Schema.Array(UiPlanItem),
  conflicts: Schema.Array(UiPlanConflict),
  /** Left alone, with why: "a Claude project's server". */
  leftAlone: Schema.Array(Schema.Struct({ item: UiPlanItem, why: Schema.String })),
  secrets: Schema.Array(UiPlanSecret),
  missing: Schema.Array(UiPlanMissing),
  /** The hub's part, when one was asked for: what it will run, in plain words. */
  hub: Schema.NullOr(
    Schema.Struct({
      node: Schema.String,
      ssh: Schema.String,
      relayUrl: Schema.NullOr(Schema.String),
      /** "Install T3 Fleet", "Join the fleet as a member", "Run the relay as a service", … */
      steps: Schema.Array(Schema.String),
    }),
  ),
  /** Every step apply will run here, in order, in plain words. */
  steps: Schema.Array(Schema.String),
});
export type UiSetupPlan = typeof UiSetupPlan.Type;

// ── doing it ────────────────────────────────────────────────────────────

export const UiSetupApplyRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("plan"),
    planId: Schema.String,
    /** Conflict id → chosen value; a missing id takes its default. */
    choices: Schema.Record(Schema.String, Schema.String),
    /** Missing credential name → value typed in; one left out is set later. */
    values: Schema.Record(Schema.String, Schema.String),
  }),
  /** Continue a stopped run as it was decided. */
  Schema.Struct({ kind: Schema.Literal("resume") }),
  /** Drop a stopped run; what it did already stays. */
  Schema.Struct({ kind: Schema.Literal("abandon") }),
]);
export type UiSetupApplyRequest = typeof UiSetupApplyRequest.Type;

/** The job apply started: watch it with the "job" events. Null for abandon. */
export const UiSetupStarted = Schema.Struct({ jobId: Schema.NullOr(Schema.String) });

export const UiInviteRequest = Schema.Struct({ node: Schema.String });
export const UiInvite = Schema.Struct({
  /** The line to run on the other machine. */
  command: Schema.String,
});
export type UiInvite = typeof UiInvite.Type;
