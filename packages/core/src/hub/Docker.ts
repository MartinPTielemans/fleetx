/**
 * Hosted servers in Docker, through the `docker` CLI.
 *
 * Every container is named fleetx-mcp-<name>, runs with `--cap-drop ALL
 * --security-opt no-new-privileges`, and publishes only on 127.0.0.1. Secrets
 * reach it as `-e NAME` with the value in the docker CLI's environment, so
 * they never appear on a command line.
 *
 *   HTTP images   run detached on a port from 18200–18299. After a hub
 *                 restart a running container with the same spec (a digest
 *                 in its labels) is adopted rather than started twice; a
 *                 stale one is replaced. A container that stops is started
 *                 again with backoff.
 *   stdio images  `docker run -i --rm`, owned by the stdio bridge like any
 *                 other process; a leftover from a crash is removed first.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { sha256 } from "../Hash.ts";
import type { StdioProcess } from "./Bridge.ts";
import { exec } from "../Exec.ts";
import { parseJson, toJson } from "./JsonRpc.ts";
import { spawnStdio } from "./Process.ts";

export const PORT_RANGE = { first: 18200, last: 18299 } as const;

export const containerName = (server: string) => `fleetx-mcp-${server}`;

export const HARDENING: ReadonlyArray<string> = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"];

export interface ContainerSpec {
  readonly server: string;
  readonly image: string;
  readonly args: ReadonlyArray<string>;
  /** Resolved values; passed through the docker CLI's environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** A digest of everything that should restart the container when it changes, secret values included. */
export const specDigest = (spec: ContainerSpec & { readonly targetPort?: number; readonly network?: string | null }) =>
  Effect.promise(() =>
    sha256(toJson([spec.image, spec.args, Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)), spec.targetPort ?? null, spec.network ?? null])),
  ).pipe(Effect.map((d) => d.slice(0, 24)));

const docker = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}, timeout: Duration.Input = Duration.seconds(60)) =>
  exec({ command: "docker", args, env: { ...process.env, ...env }, timeout });

const failure = (r: { readonly stdout: string; readonly stderr: string; readonly code: number | null; readonly timedOut: boolean; readonly spawnError?: string }) =>
  r.spawnError !== undefined ? `docker is not available: ${r.spawnError}` : r.timedOut ? "docker timed out" : (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-2).join(" ").slice(0, 300);

const envArgs = (env: Readonly<Record<string, string>>) => Object.keys(env).sort().flatMap((k) => ["-e", k]);

export interface Inspected {
  readonly running: boolean;
  readonly digest: string | null;
  readonly port: number | null;
  readonly status: string;
}

/** `docker inspect` of a container, or null when there is none. */
export const inspect = (name: string) =>
  Effect.gen(function* () {
    const r = yield* docker(["inspect", "--type", "container", name], {}, Duration.seconds(15));
    if (r.code !== 0) return null;
    const value = parseJson(r.stdout) as
      | Array<{
          State?: { Running?: boolean; Status?: string };
          Config?: { Labels?: Record<string, string> };
          HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> };
        }>
      | undefined;
    const c = value?.[0];
    if (c === undefined) return null;
    const binding = Object.values(c.HostConfig?.PortBindings ?? {}).flatMap((b) => b ?? [])[0];
    return {
      running: c.State?.Running === true,
      status: c.State?.Status ?? "unknown",
      digest: c.Config?.Labels?.["dev.fleetx.digest"] ?? null,
      port: binding?.HostPort === undefined ? null : Number(binding.HostPort),
    } satisfies Inspected;
  });

export const removeContainer = (name: string) => docker(["rm", "-f", name], {}, Duration.seconds(30)).pipe(Effect.asVoid);

/** Ports held by every fleetx-mcp-* container, running or not. */
const portsInUse = Effect.gen(function* () {
  const r = yield* docker(["ps", "-a", "--filter", "name=^fleetx-mcp-", "--format", "{{.Names}}"], {}, Duration.seconds(15));
  const used = new Set<number>();
  if (r.code !== 0) return used;
  for (const name of r.stdout.split("\n").filter((n) => n !== "")) {
    const i = yield* inspect(name);
    if (i?.port != null) used.add(i.port);
  }
  return used;
});

/**
 * Ensure an HTTP container runs with this spec: adopt a matching one,
 * otherwise (re)create it. Returns the local port.
 */
export const ensureHttpContainer = (spec: ContainerSpec & { readonly targetPort: number }, reserved: ReadonlySet<number>) =>
  Effect.gen(function* () {
    const name = containerName(spec.server);
    const digest = yield* specDigest(spec);
    const existing = yield* inspect(name);
    if (existing !== null && existing.digest === digest && existing.port !== null) {
      if (existing.running) return { port: existing.port, adopted: true };
      const started = yield* docker(["start", name]);
      if (started.code === 0) return { port: existing.port, adopted: true };
    }
    if (existing !== null) yield* removeContainer(name);
    const used = yield* portsInUse;
    let lastError = "no free port in 18200–18299";
    for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port++) {
      if (used.has(port) || reserved.has(port)) continue;
      const r = yield* docker(
        [
          "run",
          "-d",
          "--name",
          name,
          "--label",
          `dev.fleetx.hub=${spec.server}`,
          "--label",
          `dev.fleetx.digest=${digest}`,
          ...HARDENING,
          "-p",
          `127.0.0.1:${port}:${spec.targetPort}`,
          ...envArgs(spec.env),
          spec.image,
          ...spec.args,
        ],
        spec.env,
        Duration.minutes(10),
      );
      if (r.code === 0) return { port, adopted: false };
      lastError = failure(r);
      yield* removeContainer(name);
      if (!/address already in use|port is already allocated|bind/i.test(lastError)) break;
    }
    return yield* Effect.fail(`starting ${name} failed: ${lastError}`);
  });

/** `docker run -i --rm` for a stdio image, as a process the bridge supervises. */
export const spawnStdioContainer = (
  spec: ContainerSpec & { readonly network: "none" | null },
): Effect.Effect<StdioProcess, string, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const name = containerName(spec.server);
    yield* removeContainer(name);
    return yield* spawnStdio({
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "--name",
        name,
        "--label",
        `dev.fleetx.hub=${spec.server}`,
        ...HARDENING,
        ...(spec.network === "none" ? ["--network", "none"] : []),
        ...envArgs(spec.env),
        spec.image,
        ...spec.args,
      ],
      env: spec.env,
    });
  });

/** Whether the docker CLI reaches a daemon. */
export const dockerAvailable = docker(["version", "--format", "{{.Server.Version}}"], {}, Duration.seconds(10)).pipe(Effect.map((r) => r.code === 0));
