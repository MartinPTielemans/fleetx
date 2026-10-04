/**
 * The fixed runtime services and timers run with: an absolute node binary
 * and bundle, chosen once, never a login shell's PATH.
 *
 * The node is the first of these that runs Node 24 or newer: package
 * manager paths that survive upgrades (/opt/homebrew/bin, /usr/local/bin,
 * /usr/bin, a Nix profile), then the node running this probe. A version
 * manager's versioned directory is the last resort, because an upgrade
 * deletes it out from under the unit.
 */
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { exec } from "./Exec.ts";
import { sha256 } from "./Hash.ts";
import {
  BUNDLE_FILE,
  CLI,
  LEGACY_BUNDLE_FILE,
  LEGACY_CLI,
  LEGACY_SHARE_DIR,
  legacyLaunchdLabel,
  legacySystemdUnit,
  SHARE_DIR,
} from "./Names.ts";

export const MIN_NODE_MAJOR = 24;

export const stableNode = (home: string) =>
  Effect.gen(function* () {
    const candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
      `${home}/.nix-profile/bin/node`,
      "/run/current-system/sw/bin/node",
    ];
    for (const candidate of candidates) {
      const version = yield* exec({
        command: candidate,
        args: ["-p", "process.versions.node"],
        timeout: Duration.seconds(5),
      });
      if (version.code === 0 && Number(version.stdout.trim().split(".")[0]) >= MIN_NODE_MAJOR)
        return candidate;
    }
    return process.execPath;
  });

/**
 * A bundle at a fleetx path stands for the installed copy at its T3 Fleet
 * path. A unit written before the engine fix installs that copy must not
 * name the old file: the unit's first run would start the old build, which
 * puts back the fleetx units the rename just retired. Until 1.0.
 */
export const currentBundlePath = (home: string, bundle: string) =>
  bundle === `${home}/${LEGACY_SHARE_DIR}/${LEGACY_BUNDLE_FILE}` ||
  bundle === `${home}/${SHARE_DIR}/${LEGACY_BUNDLE_FILE}`
    ? `${home}/${SHARE_DIR}/${BUNDLE_FILE}`
    : bundle;

/** The bundle ~/.local/bin/t3-fleet resolves to (a development build, or the installed copy); before the rename, ~/.local/bin/fleetx. */
export const installedBundle = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bundle = yield* fs.realPath(`${home}/.local/bin/${CLI}`).pipe(
      Effect.catch(() => fs.realPath(`${home}/.local/bin/${LEGACY_CLI}`)),
      Effect.orElseSucceed(() => `${home}/${SHARE_DIR}/${BUNDLE_FILE}`),
    );
    return currentBundlePath(home, bundle);
  });

/** Whether a service or timer is still installed under its fleetx name. Until 1.0. */
export const legacyUnitInstalled = (platform: string, root: boolean, home: string, role: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file =
      platform === "darwin"
        ? `${home}/Library/LaunchAgents/${legacyLaunchdLabel(role)}.plist`
        : `${root ? "/etc/systemd/system" : `${home}/.config/systemd/user`}/${legacySystemdUnit(role)}.service`;
    return yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  });

/** "the relay is not installed", or, when it runs under its fleetx name, that it is waiting to be replaced. */
export const notInstalledTitle = (what: string, legacy: boolean | undefined) =>
  legacy === true ? `the ${what} still runs under its fleetx name` : `the ${what} is not installed`;

/**
 * Shell that stops and removes a service or timer installed under its fleetx
 * name, if there is one. Installing its T3 Fleet unit runs this first, so the
 * two never run side by side. Until 1.0.
 */
export const retireLegacyUnit = (platform: string, root: boolean, role: string) => {
  if (platform === "darwin") {
    const label = legacyLaunchdLabel(role);
    return `launchctl bootout "gui/$(id -u)/${label}" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/${label}.plist"`;
  }
  // One unit at a time: some systemd versions refuse a whole `disable --now`
  // when one of its units (a service without a timer) does not exist, and
  // stop nothing. `stop` also reaches a unit whose file is already gone.
  const unit = legacySystemdUnit(role);
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return `for u in ${unit}.timer ${unit}.service; do ${ctl} stop "$u" 2>/dev/null; ${ctl} disable "$u" 2>/dev/null; done; rm -f ${dir}/${unit}.service ${dir}/${unit}.timer; ${ctl} daemon-reload 2>/dev/null`;
};

/** launchd's ExitTimeOut when a plist sets none. */
export const LAUNCHD_DEFAULT_EXIT_TIMEOUT = 20;

/**
 * Shell that reloads a launchd job from its (rewritten) plist. `bootout`
 * only asks the old process to stop and returns at once; a `bootstrap`
 * while it is still exiting fails ("Bootstrap failed: 5: Input/output
 * error"), and once it has exited nothing is loaded at all. So this waits
 * until launchd no longer knows the job, for at most `exitTimeout` (the
 * ExitTimeOut of the plist being replaced, after which launchd kills it)
 * plus a margin, and only then bootstraps.
 */
export const launchdReload = (
  label: string,
  plist: string,
  exitTimeout: number = LAUNCHD_DEFAULT_EXIT_TIMEOUT,
) => {
  const job = `"gui/$(id -u)/${label}"`;
  return [
    `launchctl bootout ${job} 2>/dev/null`,
    `i=0; while launchctl print ${job} >/dev/null 2>&1 && [ "$i" -lt ${exitTimeout + 10} ]; do sleep 1; i=$((i + 1)); done`,
    `launchctl bootstrap "gui/$(id -u)" ${plist}`,
  ].join("\n");
};

/**
 * Completes once the bundle this process runs from holds a different build.
 * T3 Fleet's long-running services (the relay, the listener, the model proxy)
 * race their work against it and exit, and their unit (KeepAlive, or
 * Restart=always) starts the new build. Without it an update reaches the
 * timer's runs but a service keeps the code it started with, indefinitely.
 * A changed file must read the same twice, a few seconds apart, so a build
 * still being written is not taken for a new one.
 */
export const newBuild = (bundle: string, every: Duration.Input = Duration.minutes(1)) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const digest = fs.readFile(bundle).pipe(
      Effect.flatMap((bytes) => Effect.promise(() => sha256(bytes))),
      Effect.orElseSucceed(() => null),
    );
    const started = yield* digest;
    if (started === null) return yield* Effect.never;
    while (true) {
      yield* Effect.sleep(every);
      const now = yield* digest;
      if (now === null || now === started) continue;
      yield* Effect.sleep(Duration.seconds(5));
      if ((yield* digest) === now) return now;
    }
  });

/**
 * Runs a long-running service until it stops or `replaced` completes (in the
 * CLI, newBuild); then it returns, `exit` ends the process, and its unit
 * starts the new build.
 *
 * Without `drain` the service stops at once and `exit` is called as soon as
 * the new build is seen: the relay's event streams never end, so its server
 * would otherwise wait out its whole graceful shutdown first. With `drain`
 * the service keeps running until `drain` completes (the model proxy waits
 * for its responses in flight), and `exit` is called once the service has
 * stopped, its own finalizers included.
 */
export const untilReplaced = <A, E, R, R2, R3 = never>(
  service: Effect.Effect<A, E, R>,
  replaced: Effect.Effect<unknown, never, R2>,
  options: { readonly drain?: Effect.Effect<unknown, never, R3>; readonly exit: () => void },
) =>
  Effect.suspend(() => {
    let drained = false;
    const drain = options.drain;
    return Effect.raceFirst(
      service,
      replaced.pipe(
        Effect.andThen(
          drain === undefined
            ? Console.log(
                "a new T3 Fleet build is installed; exiting so the service restarts on it",
              ).pipe(Effect.andThen(Effect.sync(options.exit)))
            : Console.log(
                "a new T3 Fleet build is installed; exiting once the requests in flight are done",
              ).pipe(
                Effect.andThen(drain),
                Effect.andThen(Console.log("exiting so the service restarts on the new build")),
                Effect.andThen(
                  Effect.sync(() => {
                    drained = true;
                  }),
                ),
              ),
        ),
      ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (drained) options.exit();
        }),
      ),
    );
  });
