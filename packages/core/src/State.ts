/** What each node publishes about itself: on t3-fleet/state/<node>, and to the relay. */
import * as Schema from "effect/Schema";

import { MachineObservation } from "./Observation.ts";

/**
 * What a node's reports carry, by `format`:
 *
 *   absent  findings without their fixes (T3 Fleet before 0.10)
 *   2       each finding's fix, when it has one whose command holds none of
 *           the node's secret values; and its `t3-fleet listen` (or relay)
 *           answers fix requests (FixRequest.ts)
 *
 * A reader treats what an older format lacks as not reported, never as absent.
 */
export const REPORT_FORMAT = 2;

export const FixRecord = Schema.Struct({
  command: Schema.String,
  safe: Schema.Boolean,
  disrupts: Schema.optionalKey(Schema.String),
  on: Schema.optionalKey(Schema.String),
});

export const FindingRecord = Schema.Struct({
  node: Schema.String,
  key: Schema.String,
  severity: Schema.Literals(["error", "warn", "info"]),
  area: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  /** From format 2. */
  fix: Schema.optionalKey(FixRecord),
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
  /** See REPORT_FORMAT; absent before 2. */
  format: Schema.optionalKey(Schema.Number),
  node: Schema.String,
  at: Schema.Number,
  result: Schema.Literals(["ok", "fail"]),
  /** Failed runs in a row. */
  streak: Schema.Number,
  message: Schema.String,
  rev: Schema.String,
  observation: Schema.NullOr(MachineObservation),
  findings: Schema.Array(FindingRecord),
  applied: Schema.Array(
    Schema.Struct({ title: Schema.String, ok: Schema.Boolean, output: Schema.String }),
  ),
  /** Newest last; bounded. */
  alerts: Schema.Array(Alert),
});
export type NodeState = typeof NodeState.Type;
