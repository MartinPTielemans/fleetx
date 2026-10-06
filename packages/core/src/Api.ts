/**
 * Shapes shared between T3 Fleet's long-running parts and the UI (see
 * docs/design/companion.md). The model proxy and the hub produce these; the
 * UI server serves them; the UI reads them. One schema per shape, decoded on
 * both ends, so they agree by construction.
 *
 *   model proxy  GET /stats                    ModelProxyStats
 *   relay (hub)  GET /hub/servers              HubServer[]
 *                POST /hub/servers/<n>/login   HubLoginStart
 *                GET /hub/calls                HubCall[]
 *   t3-fleet ui  POST /api/session             (the link's one-use ticket) → UiSessionGrant
 *                GET  /api/session             UiSession
 *                GET  /api/status              UiStatus
 *                POST /api/fixes/plan          UiFixPlanRequest → UiFixPlan
 *                POST /api/fixes               UiApplyRequest → UiJob
 *                GET  /api/proposals           UiProposal[]
 *                POST /api/proposals/<node>/approve | /reject
 *                                              UiDecideRequest → UiJob
 *                GET  /api/jobs                UiJob[]
 *                GET  /api/alerts              UiAlert[]
 *                GET  /api/models              UiModels
 *                GET  /api/hub/servers         HubServer[] (from the relay)
 *                POST /api/hub/servers/<n>/login | /logout | /restart
 *                GET  /api/hub/calls           HubCall[] (from the relay)
 *                GET  /api/config/<node>       UiConfigRow[]
 *                GET  /api/skills              UiSkills
 *                POST /api/skills/lookup       UiSkillsLookupRequest → UiSkillsLookup
 *                POST /api/skills/add          UiSkillsAddRequest → UiJob
 *                POST /api/skills/preview      UiSkillsNames → UiSkillsPreview
 *                POST /api/skills/update       UiSkillsKeepRequest → UiJob
 *                POST /api/skills/remove       UiSkillsNames → UiJob
 *                GET  /api/events              server-sent events: relay events, plus "check"
 *                                              (UiStatus), "check-failed" (UiCheckFailed), "job" (UiJob)
 */
import * as Schema from "effect/Schema";

// ── models ──────────────────────────────────────────────────────────────

/** An upstream the proxy forwards to, by its name in [models.upstreams]: "anthropic", "openai", or one the fleet declares. */
export const ModelUpstream = Schema.String;
export type ModelUpstream = typeof ModelUpstream.Type;

/** Why a request failed: "connect", "timeout", "429", "5xx", "529", "4xx", "stream" (after the first byte). */
export const ModelFailureClass = Schema.Literals([
  "connect",
  "timeout",
  "429",
  "5xx",
  "529",
  "4xx",
  "stream",
]);
export type ModelFailureClass = typeof ModelFailureClass.Type;

export const ModelWindow = Schema.Struct({
  requests: Schema.Number,
  /** Requests that needed at least one retry before the first byte. */
  retried: Schema.Number,
  /** Requests that reached the client as a failure. */
  failed: Schema.Number,
  failures: Schema.Record(Schema.String, Schema.Number),
  /** Launches that ran the CLI directly because the proxy was not listening. */
  fallbacks: Schema.Number,
  ttfbP50Ms: Schema.NullOr(Schema.Number),
  ttfbP95Ms: Schema.NullOr(Schema.Number),
});
export type ModelWindow = typeof ModelWindow.Type;

export const ModelUpstreamStats = Schema.Struct({
  upstream: ModelUpstream,
  m5: ModelWindow,
  h1: ModelWindow,
  h24: ModelWindow,
  lastError: Schema.NullOr(
    Schema.Struct({ at: Schema.Number, class: ModelFailureClass, message: Schema.String }),
  ),
});
export type ModelUpstreamStats = typeof ModelUpstreamStats.Type;

export const ModelProxyStats = Schema.Struct({
  at: Schema.Number,
  startedAt: Schema.Number,
  version: Schema.String,
  egress: Schema.Literals(["direct", "relay"]),
  upstreams: Schema.Array(ModelUpstreamStats),
});
export type ModelProxyStats = typeof ModelProxyStats.Type;

/**
 * One T3 provider instance's login and health, as T3 itself reports it
 * (server.getConfig), or, when T3 cannot be read, as the CLI's own status
 * command says. Every driver T3 has, not only Claude.
 */
export const ProviderAuth = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  enabled: Schema.Boolean,
  auth: Schema.Literals(["authenticated", "unauthenticated", "unknown"]),
  /** How it is logged in, as T3 names it: "chatgpt", "apiKey", "oauth"…; from the CLI: "setup-token", "claude.ai", "api-key"…; null if unknown. */
  method: Schema.NullOr(Schema.String),
  /** T3's label for the login, e.g. "Claude Max Subscription"; null if none. Never the account's email. */
  label: Schema.NullOr(Schema.String),
  /** T3's provider state: "ready", "warning", "error", "disabled"; null when read from the CLI. */
  status: Schema.NullOr(Schema.String),
  /** T3's message, or the CLI's answer. */
  detail: Schema.String,
  /** When T3 last checked it, ms since the epoch; null when unknown. */
  checkedAt: Schema.NullOr(Schema.Number),
  source: Schema.Literals(["t3", "cli"]),
});
export type ProviderAuth = typeof ProviderAuth.Type;

// ── hub ─────────────────────────────────────────────────────────────────

export const HubServerState = Schema.Literals([
  "starting",
  "running",
  "needs-login",
  "error",
  "stopped",
]);
export type HubServerState = typeof HubServerState.Type;

export const HubServer = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  /** The remote URL, the image, or the command, for display. */
  upstream: Schema.String,
  state: HubServerState,
  detail: Schema.NullOr(Schema.String),
  auth: Schema.Literals(["none", "oauth", "bearer"]),
  /** OAuth: when the access token expires; null otherwise. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** Tools the server lists, after policy; null until known. */
  tools: Schema.NullOr(Schema.Number),
  lastCheckAt: Schema.NullOr(Schema.Number),
});
export type HubServer = typeof HubServer.Type;

export const HubCall = Schema.Struct({
  at: Schema.Number,
  server: Schema.String,
  /** The client token's name, "relay" for the shared relay token. */
  client: Schema.String,
  method: Schema.String,
  tool: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
  outcome: Schema.Literals(["ok", "error", "denied", "unauthorized"]),
  error: Schema.NullOr(Schema.String),
});
export type HubCall = typeof HubCall.Type;

export const HubLoginStart = Schema.Struct({ url: Schema.String });

// ── ui ──────────────────────────────────────────────────────────────────

export const UiFix = Schema.Struct({
  command: Schema.String,
  safe: Schema.Boolean,
  disrupts: Schema.optionalKey(Schema.String),
  on: Schema.optionalKey(Schema.String),
});

export const UiFinding = Schema.Struct({
  id: Schema.String,
  node: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  area: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(UiFix),
  /** Set when an [[accept]] entry turned this into a note. */
  accepted: Schema.optionalKey(Schema.String),
});
export type UiFinding = typeof UiFinding.Type;

export const UiProvider = Schema.Struct({
  instanceId: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  startsInT3: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  runs: Schema.NullOr(Schema.String),
  /** Whether T3 launches it through the T3 Fleet model proxy. */
  viaModels: Schema.Boolean,
});

export const UiEnvironment = Schema.Struct({
  name: Schema.String,
  roles: Schema.Array(Schema.String),
  reachable: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  platform: Schema.NullOr(Schema.String),
  t3: Schema.Struct({
    version: Schema.NullOr(Schema.String),
    channel: Schema.NullOr(Schema.String),
    behind: Schema.NullOr(Schema.Number),
  }),
  agents: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.NullOr(Schema.String),
      latest: Schema.NullOr(Schema.String),
    }),
  ),
  providers: Schema.Array(UiProvider),
  sync: Schema.NullOr(
    Schema.Struct({
      at: Schema.Number,
      result: Schema.Literals(["ok", "fail"]),
      streak: Schema.Number,
      message: Schema.String,
    }),
  ),
  providerAuth: Schema.Array(ProviderAuth),
  models: Schema.NullOr(ModelProxyStats),
});
export type UiEnvironment = typeof UiEnvironment.Type;

export const UiStatus = Schema.Struct({
  checkedAt: Schema.Number,
  elapsedMs: Schema.Number,
  /** The same text `t3-fleet status` prints. */
  summary: Schema.String,
  environments: Schema.Array(UiEnvironment),
  findings: Schema.Array(UiFinding),
});
export type UiStatus = typeof UiStatus.Type;

/** Which fixes to plan, by finding id. */
export const UiFixPlanRequest = Schema.Struct({ ids: Schema.Array(Schema.String) });

/**
 * One fix exactly as the server would run it now. `digest` names this command,
 * node, `on` and interruption together; applying sends it back, and the server
 * runs the fix only if a fresh check still gives the same digest.
 */
export const UiPlannedFix = Schema.Struct({
  id: Schema.String,
  node: Schema.String,
  title: Schema.String,
  command: Schema.String,
  safe: Schema.Boolean,
  disrupts: Schema.optionalKey(Schema.String),
  on: Schema.optionalKey(Schema.String),
  digest: Schema.String,
});
export type UiPlannedFix = typeof UiPlannedFix.Type;

const NotApplied = Schema.Struct({ id: Schema.String, reason: Schema.String });

export const UiFixPlan = Schema.Struct({
  fixes: Schema.Array(UiPlannedFix),
  notApplicable: Schema.Array(NotApplied),
});
export type UiFixPlan = typeof UiFixPlan.Type;

export const UiApplyRequest = Schema.Struct({
  fixes: Schema.Array(Schema.Struct({ id: Schema.String, digest: Schema.String })),
  /** Ids of the fixes whose interruption the user accepted; a fix that interrupts something runs only if listed. */
  acknowledged: Schema.Array(Schema.String),
});

export const UiApplyResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      node: Schema.String,
      title: Schema.String,
      ok: Schema.Boolean,
      output: Schema.String,
    }),
  ),
  notApplied: Schema.Array(NotApplied),
});
export type UiApplyResult = typeof UiApplyResult.Type;

export const UiProposal = Schema.Struct({
  node: Schema.String,
  branch: Schema.String,
  /** The staging branch's commit this diff was taken from. */
  commit: Schema.String,
  /**
   * A digest of what approving lands: each file's blob on the branch and in
   * the proposal. Approving or rejecting names it, so a newer change is not
   * decided unseen; a sync that re-creates the same change keeps it.
   */
  change: Schema.String,
  summary: Schema.String,
  files: Schema.Array(Schema.String),
  diff: Schema.String,
  autoApprovable: Schema.Boolean,
  /**
   * What approving it does besides landing the change, shown with it: a
   * proposal that makes its machine the relay also lets this authority's
   * Tailscale login into the app the hub hosts. Absent when nothing.
   */
  also: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type UiProposal = typeof UiProposal.Type;

export const UiDecideRequest = Schema.Struct({ change: Schema.String });

export const UiAlert = Schema.Struct({
  at: Schema.Number,
  node: Schema.String,
  kind: Schema.Literals(["failing", "recovered", "problem", "resolved"]),
  message: Schema.String,
});

export const UiModels = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      node: Schema.String,
      at: Schema.NullOr(Schema.Number),
      providerAuth: Schema.Array(ProviderAuth),
      stats: Schema.NullOr(ModelProxyStats),
    }),
  ),
});
export type UiModels = typeof UiModels.Type;

export const UiConfigRow = Schema.Struct({
  path: Schema.String,
  value: Schema.String,
  source: Schema.String,
});

export const UiSkillLinkState = Schema.Literals(["ok", "missing", "wrong", "real-dir"]);

/** A skill in the config repo. */
export const UiSkill = Schema.Struct({
  name: Schema.String,
  /** From its SKILL.md front matter; null when there is none on one line. */
  description: Schema.NullOr(Schema.String),
  /** The git repository it was vendored from (skills/SOURCES.json); null for the repo's own. */
  source: Schema.NullOr(Schema.Struct({ name: Schema.String, url: Schema.String })),
});
export type UiSkill = typeof UiSkill.Type;

/** One machine's skills, as its last check observed them; null fields when it was not reached or runs no skills area. */
export const UiSkillsNode = Schema.Struct({
  node: Schema.String,
  at: Schema.NullOr(Schema.Number),
  store: Schema.NullOr(Schema.String),
  links: Schema.Array(
    Schema.Struct({ skill: Schema.String, dir: Schema.String, state: UiSkillLinkState }),
  ),
  /** Skills installed outside T3 Fleet: name and directory. */
  strays: Schema.Array(Schema.Struct({ skill: Schema.String, dir: Schema.String })),
  dangling: Schema.Array(Schema.Struct({ skill: Schema.String, dir: Schema.String })),
  /** [skills] ignore on this machine. */
  ignored: Schema.Array(Schema.String),
});
export type UiSkillsNode = typeof UiSkillsNode.Type;

export const UiSkills = Schema.Struct({
  skills: Schema.Array(UiSkill),
  nodes: Schema.Array(UiSkillsNode),
});
export type UiSkills = typeof UiSkills.Type;

export const UiSkillsLookupRequest = Schema.Struct({ source: Schema.String });
export const UiSkillsLookup = Schema.Struct({
  url: Schema.String,
  skills: Schema.Array(Schema.Struct({ name: Schema.String, exists: Schema.Boolean })),
});
export type UiSkillsLookup = typeof UiSkillsLookup.Type;

export const UiSkillsAddRequest = Schema.Struct({
  source: Schema.String,
  skills: Schema.Array(Schema.String),
  as: Schema.optionalKey(Schema.String),
});

/** Skill names; empty means every skill with a source, for update. */
export const UiSkillsNames = Schema.Struct({ skills: Schema.Array(Schema.String) });

/** What an update would change, already put back; `digest` is "" when nothing would. */
export const UiSkillsPreview = Schema.Struct({
  files: Schema.Array(Schema.String),
  stat: Schema.String,
  diff: Schema.String,
  digest: Schema.String,
  /** Skills a whole-fleet update leaves out: sync holds back an edit there. */
  skipped: Schema.Array(Schema.String),
});
export type UiSkillsPreview = typeof UiSkillsPreview.Type;

export const UiSkillsKeepRequest = Schema.Struct({
  skills: Schema.Array(Schema.String),
  digest: Schema.String,
});

/** What changed in the repo, and whether it was committed or waits for the next sync to propose it. */
export const UiSkillsLanded = Schema.Struct({
  paths: Schema.Array(Schema.String),
  landed: Schema.String,
});
export type UiSkillsLanded = typeof UiSkillsLanded.Type;

// ── jobs ────────────────────────────────────────────────────────────────

export const UiJobKind = Schema.Literals([
  "fixes",
  "approve",
  "reject",
  "skills-add",
  "skills-update",
  "skills-remove",
  "setup",
  "setup-hub",
]);
export type UiJobKind = typeof UiJobKind.Type;

/**
 * Something that changes machines or the config repo. It runs in the server,
 * not in the request that started it, so closing or reloading the tab does
 * not stop it; every change to it is a "job" event.
 */
export const UiJob = Schema.Struct({
  id: Schema.String,
  kind: UiJobKind,
  /** What it does: "Apply 2 fixes on 1 machine". */
  title: Schema.String,
  state: Schema.Literals(["waiting", "running", "done", "failed"]),
  /** What it is doing now, while it runs. */
  step: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  /** Fixes: what ran and what did not. */
  applied: Schema.NullOr(UiApplyResult),
  /** Skill changes: what changed in the repo. */
  landed: Schema.NullOr(UiSkillsLanded),
});
export type UiJob = typeof UiJob.Type;

/** A check that did not finish; the last good one is still shown. */
export const UiCheckFailed = Schema.Struct({ at: Schema.Number, message: Schema.String });
export type UiCheckFailed = typeof UiCheckFailed.Type;

/** What the link's one-use ticket is traded for: this tab's token. */
export const UiSessionGrant = Schema.Struct({ token: Schema.String });

/** Who is asking, so the UI can label this machine and offer only what it may do. */
export const UiSession = Schema.Struct({
  version: Schema.String,
  /** This machine's node name. */
  self: Schema.String,
  /** Whether this machine may approve and reject proposals. */
  authority: Schema.Boolean,
  nodes: Schema.Array(Schema.String),
  /** The relay's URL, when the fleet has one; the hub and live events go through it. */
  relay: Schema.NullOr(Schema.String),
  /**
   * Present when the app is served by the hub (HubUi.ts), not `t3-fleet ui`
   * on this machine: who is signed in, and where proposals are decided
   * (never on the hub). Machines are shown as they last reported.
   */
  hub: Schema.optionalKey(
    Schema.Struct({ login: Schema.String, approveOn: Schema.Array(Schema.String) }),
  ),
});
export type UiSession = typeof UiSession.Type;
