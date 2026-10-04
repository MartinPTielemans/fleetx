/** What each node publishes about itself: on t3-fleet/state/<node>, and to the relay. */
import * as Schema from "effect/Schema";

import { MachineObservation } from "./Observation.ts";

export const FindingRecord = Schema.Struct({
  node: Schema.String,
  key: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  area: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
});

export const Alert = Schema.Struct({
  at: Schema.Number,
  node: Schema.String,
  kind: Schema.Literals(["failing", "recovered", "problem", "resolved"]),
  message: Schema.String,
});
export type Alert = typeof Alert.Type;

/** What a node publishes on t3-fleet/state/<node>. */
export const NodeState = Schema.Struct({
  node: Schema.String,
  at: Schema.Number,
  result: Schema.Literals(["ok", "fail"]),
  /** Failed runs in a row. */
  streak: Schema.Number,
  message: Schema.String,
  rev: Schema.String,
  observation: Schema.NullOr(MachineObservation),
  findings: Schema.Array(FindingRecord),
  applied: Schema.Array(Schema.Struct({ title: Schema.String, ok: Schema.Boolean, output: Schema.String })),
  /** Newest last; bounded. */
  alerts: Schema.Array(Alert),
});
export type NodeState = typeof NodeState.Type;

