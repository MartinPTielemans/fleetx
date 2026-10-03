/**
 * Shapes shared between fleetx's long-running parts and the UI (see
 * docs/design/companion.md). The model proxy and the hub produce these; the
 * UI server serves them; the UI reads them. One schema per shape, decoded on
 * both ends, so they agree by construction.
 *
 *   model proxy  GET /stats                    ModelProxyStats
 *   relay (hub)  GET /hub/servers              HubServer[]
 *                POST /hub/servers/<n>/login   HubLoginStart
 *                GET /hub/calls                HubCall[]
 *   fleetx ui    GET  /api/status              UiStatus
 *                POST /api/fixes               UiApplyRequest → UiApplyResult
 *                GET  /api/proposals           UiProposal[]
 *                POST /api/proposals/<node>/approve | /reject
 *                GET  /api/alerts              UiAlert[]
 *                GET  /api/models              UiModels
 *                GET  /api/hub/servers         HubServer[] (from the relay)
 *                POST /api/hub/servers/<n>/login | /logout | /restart
 *                GET  /api/hub/calls           HubCall[] (from the relay)
 *                GET  /api/config/<node>       UiConfigRow[]
 *                GET  /api/session             UiSession
 *                GET  /api/events              server-sent events: relay events, plus "check"
 */
import * as Schema from "effect/Schema";

// ── models ──────────────────────────────────────────────────────────────

/** An upstream the proxy forwards to, by its name in [models.upstreams]: "anthropic", "openai", or one the fleet declares. */
export const ModelUpstream = Schema.String;
export type ModelUpstream = typeof ModelUpstream.Type;

/** Why a request failed: "connect", "timeout", "429", "5xx", "529", "4xx", "stream" (after the first byte). */
export const ModelFailureClass = Schema.Literals(["connect", "timeout", "429", "5xx", "529", "4xx", "stream"]);
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
  lastError: Schema.NullOr(Schema.Struct({ at: Schema.Number, class: ModelFailureClass, message: Schema.String })),
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

export const HubServerState = Schema.Literals(["starting", "running", "needs-login", "error", "stopped"]);
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
  /** Whether T3 launches it through the fleetx model proxy. */
  viaModels: Schema.Boolean,
});

export const UiEnvironment = Schema.Struct({
  name: Schema.String,
  roles: Schema.Array(Schema.String),
  reachable: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  platform: Schema.NullOr(Schema.String),
  t3: Schema.Struct({ version: Schema.NullOr(Schema.String), channel: Schema.NullOr(Schema.String), behind: Schema.NullOr(Schema.Number) }),
  agents: Schema.Array(Schema.Struct({ name: Schema.String, version: Schema.NullOr(Schema.String), latest: Schema.NullOr(Schema.String) })),
  providers: Schema.Array(UiProvider),
  sync: Schema.NullOr(Schema.Struct({ at: Schema.Number, result: Schema.Literals(["ok", "fail"]), streak: Schema.Number, message: Schema.String })),
  providerAuth: Schema.Array(ProviderAuth),
  models: Schema.NullOr(ModelProxyStats),
});
export type UiEnvironment = typeof UiEnvironment.Type;

export const UiStatus = Schema.Struct({
  checkedAt: Schema.Number,
  elapsedMs: Schema.Number,
  /** The same text `fleetx status` prints. */
  summary: Schema.String,
  environments: Schema.Array(UiEnvironment),
  findings: Schema.Array(UiFinding),
});
export type UiStatus = typeof UiStatus.Type;

export const UiApplyRequest = Schema.Struct({ ids: Schema.Array(Schema.String) });

export const UiApplyResult = Schema.Struct({
  results: Schema.Array(Schema.Struct({ id: Schema.String, node: Schema.String, title: Schema.String, ok: Schema.Boolean, output: Schema.String })),
  notApplied: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
  status: UiStatus,
});
export type UiApplyResult = typeof UiApplyResult.Type;

export const UiProposal = Schema.Struct({
  node: Schema.String,
  branch: Schema.String,
  summary: Schema.String,
  files: Schema.Array(Schema.String),
  diff: Schema.String,
  autoApprovable: Schema.Boolean,
});
export type UiProposal = typeof UiProposal.Type;

export const UiAlert = Schema.Struct({
  at: Schema.Number,
  node: Schema.String,
  kind: Schema.Literals(["failing", "recovered", "problem", "resolved"]),
  message: Schema.String,
});

export const UiModels = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ node: Schema.String, at: Schema.NullOr(Schema.Number), providerAuth: Schema.Array(ProviderAuth), stats: Schema.NullOr(ModelProxyStats) })),
});
export type UiModels = typeof UiModels.Type;

export const UiConfigRow = Schema.Struct({ path: Schema.String, value: Schema.String, source: Schema.String });

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
});
export type UiSession = typeof UiSession.Type;
