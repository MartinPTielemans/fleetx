/**
 * Hosted servers in Docker, through the `docker` CLI.
 *
 * Every container is named t3-fleet-mcp-<name> (one still named
 * fleetx-mcp-<name> from before the rename is renamed and adopted), runs with `--cap-drop ALL
 * --security-opt no-new-privileges`, and publishes only on 127.0.0.1. Its
 * environment reaches it through `--env-file`, a mode-600 file in a private
 * temporary directory removed as soon as the docker CLI has read it: values
 * never appear on a command line, and never enter the docker CLI's own
 * environment (where DOCKER_HOST or PATH would change what docker does).
 *
 *   HTTP images   run detached on a port from 18200–18299. After a hub
 *                 restart a running container with the same spec (a digest
 *                 in its labels) is adopted rather than started twice; a
 *                 stale one is replaced. A container that stops is started
 *                 again with backoff. A `docker run` that fails removes the
 *                 container only when it carries that run's own label: the
 *                 name may belong to a container something else just started.
 *   stdio images  `docker run -i --rm`, owned by the stdio bridge like any
 *                 other process; a leftover from a crash is removed first.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { sha256 } from "../Hash.ts";
import { CONTAINER_LABEL, CONTAINER_PREFIX, LEGACY_CONTAINER_LABEL, LEGACY_CONTAINER_PREFIX } from "../Names.ts";
import type { StdioProcess } from "./Bridge.ts";
import { exec } from "../Exec.ts";
import { IMAGE_PATTERN } from "./Definitions.ts";
import { parseJson, toJson } from "./JsonRpc.ts";
import { randomSecret } from "./Policy.ts";
import { spawnStdio } from "./Process.ts";

export const PORT_RANGE = { first: 18200, last: 18299 } as const;

export const containerName = (server: string) => `${CONTAINER_PREFIX}${server}`;
const legacyContainerName = (server: string) => `${LEGACY_CONTAINER_PREFIX}${server}`;

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

/**
 * Write the environment to a private env file for `--env-file`, in a
 * temporary directory that lives as long as the enclosing scope.
 */
export const envFile = (env: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const keys = Object.keys(env).sort();
    if (keys.length === 0) return [] as Array<string>;
    for (const key of keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return yield* Effect.fail(`env name ${key} is not valid`);
      if (/[\r\n\0]/.test(env[key] ?? "")) return yield* Effect.fail(`env ${key} has a line break, which an env file cannot carry`);
    }
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fleet-hub-" }).pipe(Effect.mapError(() => "cannot create a private temporary directory"));
    yield* fs.chmod(dir, 0o700).pipe(Effect.ignore);
    const file = `${dir}/env`;
    yield* fs
      .writeFileString(file, keys.map((k) => `${k}=${env[k] ?? ""}\n`).join(""), { mode: 0o600 })
      .pipe(Effect.mapError(() => "cannot write the container's env file"));
    return ["--env-file", file];
  });

const checkImage = (image: string) => (IMAGE_PATTERN.test(image) ? Effect.void : Effect.fail(`not an image reference: ${image}`));

export interface Inspected {
  readonly running: boolean;
  readonly digest: string | null;
  readonly port: number | null;
  readonly status: string;
  /** The label of the `docker run` that created it. */
  readonly run: string | null;
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
      digest: c.Config?.Labels?.[`${CONTAINER_LABEL}.digest`] ?? c.Config?.Labels?.[`${LEGACY_CONTAINER_LABEL}.digest`] ?? null,
      port: binding?.HostPort === undefined ? null : Number(binding.HostPort),
      run: c.Config?.Labels?.[`${CONTAINER_LABEL}.run`] ?? null,
    } satisfies Inspected;
  });

export const removeContainer = (name: string) => docker(["rm", "-f", name], {}, Duration.seconds(30)).pipe(Effect.asVoid);

/** Ports held by every t3-fleet-mcp-* (or fleetx-mcp-*) container, running or not. */
const portsInUse = Effect.gen(function* () {
  const r = yield* docker(
    ["ps", "-a", "--filter", `name=^${CONTAINER_PREFIX}`, "--filter", `name=^${LEGACY_CONTAINER_PREFIX}`, "--format", "{{.Names}}"],
    {},
    Duration.seconds(15),
  );
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
    // A container from before the rename takes the new name, keeping whatever it runs. Until 1.0.
    if ((yield* inspect(name)) === null && (yield* inspect(legacyContainerName(spec.server))) !== null) {
      yield* docker(["rename", legacyContainerName(spec.server), name], {}, Duration.seconds(15));
    }
    const existing = yield* inspect(name);
    if (existing !== null && existing.digest === digest && existing.port !== null) {
      if (existing.running) return { port: existing.port, adopted: true };
      const started = yield* docker(["start", name]);
      if (started.code === 0) return { port: existing.port, adopted: true };
    }
    if (existing !== null) yield* removeContainer(name);
    yield* checkImage(spec.image);
    const used = yield* portsInUse;
    let lastError = "no free port in 18200–18299";
    for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port++) {
      if (used.has(port) || reserved.has(port)) continue;
      const run = randomSecret();
      const r = yield* Effect.scoped(
        Effect.gen(function* () {
          const envArgs = yield* envFile(spec.env);
          return yield* docker(
        [
          "run",
          "-d",
          "--name",
          name,
          "--label",
          `${CONTAINER_LABEL}.hub=${spec.server}`,
          "--label",
          `${CONTAINER_LABEL}.digest=${digest}`,
          "--label",
          `${CONTAINER_LABEL}.run=${run}`,
          ...HARDENING,
          "-p",
          `127.0.0.1:${port}:${spec.targetPort}`,
          ...envArgs,
          spec.image,
          ...spec.args,
        ],
        {},
        Duration.minutes(10),
          );
        }),
      );
      if (r.code === 0) return { port, adopted: false };
      lastError = failure(r);
      // A container left in "created" by a failed port binding is this run's; one that took the name meanwhile is not.
      if ((yield* inspect(name))?.run === run) yield* removeContainer(name);
      if (!/address already in use|port is already allocated|bind/i.test(lastError)) break;
    }
    return yield* Effect.fail(`starting ${name} failed: ${lastError}`);
  });

/** `docker run -i --rm` for a stdio image, as a process the bridge supervises. */
export const spawnStdioContainer = (
  spec: ContainerSpec & { readonly network: "none" | null },
): Effect.Effect<StdioProcess, string, Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const name = containerName(spec.server);
    yield* checkImage(spec.image);
    yield* removeContainer(name);
    yield* removeContainer(legacyContainerName(spec.server));
    // The env file lives in its own scope: removed seconds after docker has read it, or when the process stops.
    const fileScope = yield* Scope.fork(yield* Effect.scope);
    const envArgs = yield* envFile(spec.env).pipe(Effect.provideService(Scope.Scope, fileScope));
    yield* Scope.close(fileScope, Exit.void).pipe(Effect.delay(Duration.seconds(10)), Effect.forkScoped);
    return yield* spawnStdio({
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "--name",
        name,
        "--label",
        `${CONTAINER_LABEL}.hub=${spec.server}`,
        ...HARDENING,
        ...(spec.network === "none" ? ["--network", "none"] : []),
        ...envArgs,
        spec.image,
        ...spec.args,
      ],
      env: {},
    });
  });

/** Whether the docker CLI reaches a daemon. */
export const dockerAvailable = docker(["version", "--format", "{{.Server.Version}}"], {}, Duration.seconds(10)).pipe(Effect.map((r) => r.code === 0));
