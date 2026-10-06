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

import { exec, type ExecInput } from "./Exec.ts";
import type { Node, ProbeSettings } from "./Config.ts";
import { BUNDLE_FILE, SHARE_DIR } from "./Names.ts";
import { MachineObservation } from "./Observation.ts";
import { probeMachine } from "./Probe.ts";

export type NodeResult =
  | {
      readonly node: Node;
      readonly ok: true;
      readonly observation: MachineObservation;
      readonly ms: number;
    }
  | { readonly node: Node; readonly ok: false; readonly error: string; readonly ms: number };

const decode = Schema.decodeEffect(Schema.fromJsonString(MachineObservation));

/** Settings travel as one base64url argument: no quoting through ssh and bash. */
export const encodeSettings = (settings: ProbeSettings) =>
  Buffer.from(JSON.stringify(settings)).toString("base64url");

const lastLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .pop() ?? "";

/** Exit status of `installedProbe` when the node's installed copy is not the wanted build. */
export const NOT_INSTALLED = 97;

/**
 * Runs the node's installed copy when its SHA-256 is `engine`, else exits
 * NOT_INSTALLED. The copy is taken first, then hashed and run, so an install
 * landing in between cannot swap the build that was checked. Only POSIX
 * tools: sha256sum on Linux, shasum on macOS.
 */
export const installedProbe = (engine: string, settings: ProbeSettings) =>
  [
    `d=$(mktemp -d 2>/dev/null) || exit ${NOT_INSTALLED}`,
    `t="$d/${BUNDLE_FILE}"`,
    `cp "$HOME/${SHARE_DIR}/${BUNDLE_FILE}" "$t" 2>/dev/null || { rm -rf "$d"; exit ${NOT_INSTALLED}; }`,
    `h=$( (sha256sum "$t" || shasum -a 256 "$t") 2>/dev/null | cut -d" " -f1)`,
    `[ "$h" = ${engine} ] || { rm -rf "$d"; exit ${NOT_INSTALLED}; }`,
    `node "$t" probe ${encodeSettings(settings)}`,
    `s=$?`,
    `rm -rf "$d"`,
    `exit $s`,
  ].join("; ");

/** Nodes (ssh target and build) whose installed copy was not the wanted build. */
const notInstalled = new Set<string>();

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** A destination, not ssh options or shell syntax. Aliases and user@host are supported. */
export const validSshDestination = (ssh: string) =>
  ssh !== "" &&
  !ssh.startsWith("-") &&
  !/\s/.test(ssh) &&
  !Array.from(ssh).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/**
 * The same bounded, non-interactive transport for checks and setup. Stdin may
 * be a bundle or shell script. Regular checks respect the user's SSH host-key
 * policy; the wizard opts into read-only host-key handling.
 */
export const remoteExec = (
  ssh: string,
  input: Omit<ExecInput, "command" | "args" | "env" | "extendEnv"> & {
    readonly command: string;
    readonly readonlyHostKeys?: boolean;
  },
) =>
  validSshDestination(ssh)
    ? exec({
        command: "ssh",
        args: [
          ...SSH,
          ...(input.readonlyHostKeys
            ? ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"]
            : []),
          ...(input.stdin === undefined ? ["-n"] : ["-o", "Compression=yes"]),
          "--",
          ssh,
          input.command,
        ],
        env: process.env,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        timeout: input.timeout ?? Duration.seconds(90),
      })
    : Effect.succeed({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: false,
        spawnError: "Enter an SSH host or user@host, without options or spaces.",
      });

/**
 * Observes a node over ssh: its own copy first, unless it is known not to
 * have this build, then the bundle when the copy is missing or failed. An
 * unreachable node or one that times out is not asked twice.
 */
export const probeRemote = (
  ssh: string,
  bundle: string,
  settings: ProbeSettings,
  engine: string | undefined,
  timeoutSeconds = 90,
) =>
  Effect.gen(function* () {
    const key = `${ssh}\n${engine ?? ""}`;
    let run =
      engine === undefined || notInstalled.has(key)
        ? null
        : yield* remoteExec(ssh, {
            command: `bash -lc '${installedProbe(engine, settings)}'`,
            timeout: Duration.seconds(timeoutSeconds),
          });
    if (run !== null && run.code === NOT_INSTALLED) notInstalled.add(key);
    // Anything but an answer or an unreachable node tries the bundle; it may run where the copy did not.
    if (run === null || (!run.timedOut && run.code !== 0 && run.code !== 255)) {
      run = yield* remoteExec(ssh, {
        command: `bash -lc 'node --input-type=module - probe ${encodeSettings(settings)}'`,
        stdin: bundle,
        timeout: Duration.seconds(timeoutSeconds),
      });
    }
    if (run.timedOut) return yield* Effect.fail(`no answer from ${ssh} within ${timeoutSeconds}s`);
    if (run.code === 255)
      return yield* Effect.fail(`ssh ${ssh} failed: ${lastLine(run.stderr) || "unreachable"}`);
    if (run.code !== 0)
      return yield* Effect.fail(
        `probe exited ${run.code}: ${lastLine(run.stderr) || lastLine(run.stdout)}`,
      );
    const observation = yield* decode(lastLine(run.stdout)).pipe(
      Effect.mapError(() => "probe output was not understood (is its node older than 24?)"),
    );
    // Installed since (a fix): its own copy runs from the next check on.
    const installed = observation.areas["engine"];
    if (
      typeof installed === "object" &&
      installed !== null &&
      "installed" in installed &&
      installed.installed === engine
    )
      notInstalled.delete(key);
    return observation;
  });

/** `engine` is the SHA-256 of `bundle`; given, a node with that build installed runs its own copy. */
export const observeNode = (
  node: Node,
  bundle: string,
  settings: ProbeSettings = {},
  engine?: string,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* (
      node.ssh === null ? probeMachine(settings) : probeRemote(node.ssh, bundle, settings, engine)
    ).pipe(Effect.result);
    const ms = (yield* Clock.currentTimeMillis) - started;
    return result._tag === "Success"
      ? ({ node, ok: true, observation: result.success, ms } satisfies NodeResult)
      : ({ node, ok: false, error: String(result.failure), ms } satisfies NodeResult);
  });
