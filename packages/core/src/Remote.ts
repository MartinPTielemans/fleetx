/**
 * Observing a node. The local machine is probed in-process; any other is
 * reached over ssh, with this very bundle streamed into `node -` so nothing
 * has to be installed there first. A login shell runs it, because that is
 * where a machine's own node lives (a version manager's shims, for example).
 *
 * A node that already has this exact build installed runs its own copy
 * instead, so a check sends a few hundred bytes rather than the bundle; the
 * copy's hash is checked on the node first. One that does not have it is
 * remembered, and gets the bundle straight away until it has the build.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { exec } from "./Exec.ts";
import type { Node, ProbeSettings } from "./Config.ts";
import { BUNDLE_FILE, SHARE_DIR } from "./Names.ts";
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

/** Exit status of `installedProbe` when the node's installed copy is not the wanted build. */
export const NOT_INSTALLED = 97;

/**
 * Runs the node's installed copy when its SHA-256 is `engine`, else exits
 * NOT_INSTALLED. Only POSIX tools: sha256sum on Linux, shasum on macOS.
 */
export const installedProbe = (engine: string, settings: ProbeSettings) =>
  [
    `f="$HOME/${SHARE_DIR}/${BUNDLE_FILE}"`,
    `h=$( (sha256sum "$f" || shasum -a 256 "$f") 2>/dev/null | cut -d" " -f1)`,
    `[ "$h" = ${engine} ] || exit ${NOT_INSTALLED}`,
    `exec node "$f" probe ${encodeSettings(settings)}`,
  ].join("; ");

/** Nodes (ssh target and build) whose installed copy was not the wanted build. */
const notInstalled = new Set<string>();

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

const probeRemote = (ssh: string, bundle: string, settings: ProbeSettings, engine: string | undefined) =>
  Effect.gen(function* () {
    const key = `${ssh}\n${engine ?? ""}`;
    let run = engine === undefined || notInstalled.has(key)
      ? null
      : yield* exec({ command: "ssh", args: [...SSH, "-n", ssh, `bash -lc '${installedProbe(engine, settings)}'`], env: process.env, timeout: Duration.seconds(90) });
    if (run !== null && run.code === NOT_INSTALLED) notInstalled.add(key);
    // Anything but an answer or an unreachable node tries the bundle; it may run where the copy did not.
    if (run === null || (!run.timedOut && run.code !== 0 && run.code !== 255)) {
      run = yield* exec({
        command: "ssh",
        // Compressed: the bundle is mostly text.
        args: [...SSH, "-o", "Compression=yes", ssh, `bash -lc 'node --input-type=module - probe ${encodeSettings(settings)}'`],
        env: process.env,
        stdin: bundle,
        timeout: Duration.seconds(90),
      });
    }
    if (run.timedOut) return yield* Effect.fail(`no answer from ${ssh} within 90s`);
    if (run.code === 255) return yield* Effect.fail(`ssh ${ssh} failed: ${lastLine(run.stderr) || "unreachable"}`);
    if (run.code !== 0) return yield* Effect.fail(`probe exited ${run.code}: ${lastLine(run.stderr) || lastLine(run.stdout)}`);
    const observation = yield* decode(lastLine(run.stdout)).pipe(
      Effect.mapError(() => "probe output was not understood (is its node older than 24?)"),
    );
    // Installed since (a fix): its own copy runs from the next check on.
    const installed = observation.areas["engine"];
    if (typeof installed === "object" && installed !== null && "installed" in installed && installed.installed === engine) notInstalled.delete(key);
    return observation;
  });

/** `engine` is the SHA-256 of `bundle`; given, a node with that build installed runs its own copy. */
export const observeNode = (node: Node, bundle: string, settings: ProbeSettings = {}, engine?: string) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* (node.ssh === null ? probeMachine(settings) : probeRemote(node.ssh, bundle, settings, engine)).pipe(Effect.result);
    const ms = (yield* Clock.currentTimeMillis) - started;
    return result._tag === "Success"
      ? ({ node, ok: true, observation: result.success, ms } satisfies NodeResult)
      : ({ node, ok: false, error: String(result.failure), ms } satisfies NodeResult);
  });
