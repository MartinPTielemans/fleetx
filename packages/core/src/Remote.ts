/**
 * Observing a node. The local machine is probed in-process; any other is
 * reached over ssh, with this very bundle streamed into `node -` so nothing
 * has to be installed there first. A login shell runs it, because that is
 * where a machine's own node lives (a version manager's shims, for example).
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { exec } from "./Exec.ts";
import type { Node, ProbeSettings } from "./Config.ts";
import { MachineObservation } from "./Observation.ts";
import { probeMachine } from "./Probe.ts";

export type NodeResult =
  | { readonly node: Node; readonly ok: true; readonly observation: MachineObservation; readonly ms: number }
  | { readonly node: Node; readonly ok: false; readonly error: string; readonly ms: number };

const decode = Schema.decodeEffect(Schema.fromJsonString(MachineObservation));

/** Settings travel as one base64url argument: no quoting through ssh and bash. */
export const encodeSettings = (settings: ProbeSettings) => Buffer.from(JSON.stringify(settings)).toString("base64url");

const lastLine = (text: string) =>
  text.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";

const probeRemote = (ssh: string, bundle: string, settings: ProbeSettings) =>
  Effect.gen(function* () {
    const run = yield* exec({
      command: "ssh",
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ssh, `bash -lc 'node --input-type=module - probe ${encodeSettings(settings)}'`],
      env: process.env,
      stdin: bundle,
      timeout: Duration.seconds(90),
    });
    if (run.timedOut) return yield* Effect.fail(`no answer from ${ssh} within 90s`);
    if (run.code === 255) return yield* Effect.fail(`ssh ${ssh} failed: ${lastLine(run.stderr) || "unreachable"}`);
    if (run.code !== 0) return yield* Effect.fail(`probe exited ${run.code}: ${lastLine(run.stderr) || lastLine(run.stdout)}`);
    return yield* decode(lastLine(run.stdout)).pipe(
      Effect.mapError(() => "probe output was not understood (is its node older than 24?)"),
    );
  });

export const observeNode = (node: Node, bundle: string, settings: ProbeSettings = {}) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* (node.ssh === null ? probeMachine(settings) : probeRemote(node.ssh, bundle, settings)).pipe(Effect.result);
    const ms = (yield* Clock.currentTimeMillis) - started;
    return result._tag === "Success"
      ? ({ node, ok: true, observation: result.success, ms } satisfies NodeResult)
      : ({ node, ok: false, error: String(result.failure), ms } satisfies NodeResult);
  });
