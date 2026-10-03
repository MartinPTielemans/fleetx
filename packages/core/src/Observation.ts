/**
 * What a probe reports about one machine. The probe runs on that machine
 * (streamed over ssh into `node -`), prints this as JSON, and the controller
 * decodes it with the same schema, so both ends agree by construction.
 *
 * Observations are facts only. Whether a fact is a problem is decided later,
 * in Diagnose, with knowledge the machine does not have: the latest releases
 * and what the other machines look like.
 */
import * as Schema from "effect/Schema";

export const PROBE_PROTOCOL = 3;

/** An agent CLI as fleet manages it, plus every other copy PATH can reach. */
export const AgentObservation = Schema.Struct({
  name: Schema.Literals(["claude", "codex"]),
  managedPath: Schema.String,
  managedVersion: Schema.NullOr(Schema.String),
  /** Every match on the login PATH, in resolution order. */
  onPath: Schema.Array(Schema.String),
});
export type AgentObservation = typeof AgentObservation.Type;

/** How the running T3 server would launch one provider. */
export const ProviderObservation = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  enabled: Schema.Boolean,
  /** As configured: an absolute path or a bare command name. */
  binaryPath: Schema.NullOr(Schema.String),
  /** Resolved against the T3 server's own PATH, not the login shell's. */
  resolved: Schema.NullOr(Schema.String),
  /** `<resolved> --version` run with the server's environment. */
  launch: Schema.Struct({
    ok: Schema.Boolean,
    version: Schema.NullOr(Schema.String),
    detail: Schema.String,
  }),
});
export type ProviderObservation = typeof ProviderObservation.Type;

export const T3Observation = Schema.Struct({
  /** From ~/.t3/userdata/server-runtime.json; null when T3 never ran here. */
  runtime: Schema.NullOr(
    Schema.Struct({
      pid: Schema.Number,
      origin: Schema.String,
      serviceManaged: Schema.Boolean,
      alive: Schema.Boolean,
      startedAt: Schema.NullOr(Schema.String),
    }),
  ),
  /** From the server's /.well-known/t3/environment; null when unreachable. */
  descriptor: Schema.NullOr(
    Schema.Struct({
      environmentId: Schema.String,
      label: Schema.String,
      serverVersion: Schema.String,
    }),
  ),
  /** Where the version came from when the descriptor was unreachable. */
  installedVersion: Schema.NullOr(Schema.String),
  /** The `t3` binary the server runs from (~/.t3/runtime/versions/<v>/t3); null for the desktop app. */
  runtimeBinary: Schema.NullOr(Schema.String),
  /** PATH of the running server process; null when unreadable. */
  serverPath: Schema.NullOr(Schema.String),
  providers: Schema.Array(ProviderObservation),
  problems: Schema.Array(Schema.String),
});
export type T3Observation = typeof T3Observation.Type;

/**
 * The model proxy the config declares, as this machine would use it: which
 * launchers are installed, and whether the proxy accepts this machine's key
 * (a /models request, which costs no model call). Null when the config
 * declares no proxy.
 */
export const ProxyObservation = Schema.Struct({
  /** Per T3 provider instance: the installed launcher's path, or null. */
  launchers: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  credentials: Schema.Boolean,
  /** "accepted", "rejected" (401/403), or what went wrong; null without credentials. */
  key: Schema.NullOr(Schema.String),
});
export type ProxyObservation = typeof ProxyObservation.Type;

/** The record a bash `fleet sync` timer leaves, where one runs alongside fleetx. */
export const LegacySyncObservation = Schema.Struct({
  when: Schema.Number,
  result: Schema.String,
  message: Schema.String,
  streak: Schema.Number,
});
export type LegacySyncObservation = typeof LegacySyncObservation.Type;

export const MachineObservation = Schema.Struct({
  protocol: Schema.Literal(PROBE_PROTOCOL),
  hostname: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  user: Schema.String,
  observedAt: Schema.Number,
  agents: Schema.Array(AgentObservation),
  t3: T3Observation,
  proxy: Schema.NullOr(ProxyObservation),
  legacySync: Schema.NullOr(LegacySyncObservation),
});
export type MachineObservation = typeof MachineObservation.Type;
