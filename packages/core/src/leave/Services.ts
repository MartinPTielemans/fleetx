/**
 * T3 Fleet's services and timers on this machine: the sync timer, `listen`,
 * `relay serve` and the model proxy, as launchd jobs on macOS and systemd
 * units elsewhere, user or system.
 *
 * A unit file is removed only once its service is known to be stopped: a job
 * launchd still has loaded, or a unit systemd still has active or enabled,
 * fails the step with its unit left in place.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { exec } from "../Exec.ts";
import { launchdLabel, systemdUnit } from "../Names.ts";

/** Each service, and how long its stop may take before launchd kills it (plus a margin). */
export const SERVICES = [
  { role: "sync", what: "the sync timer", wait: 30 },
  { role: "listen", what: "the listener", wait: 30 },
  { role: "serve", what: "the relay", wait: 30 },
  // The proxy drains the responses in flight (Launchers.ts, STOP_TIMEOUT_SECONDS).
  { role: "models", what: "the model proxy", wait: 85 },
] as const;

export const SYSTEM_DIR = "/etc/systemd/system";

const unitFiles = (role: string) =>
  role === "sync"
    ? [`${systemdUnit(role)}.timer`, `${systemdUnit(role)}.service`]
    : [`${systemdUnit(role)}.service`];

/**
 * Shell that stops one service and, once it is verifiably stopped, removes its
 * unit files. Fails (exit 1, with why on stderr) and keeps them otherwise.
 */
export const removeService = (
  platform: string,
  scope: "user" | "system",
  role: string,
  wait: number,
  systemDir: string = SYSTEM_DIR,
) => {
  if (platform === "darwin") {
    const job = `"gui/$(id -u)/${launchdLabel(role)}"`;
    // launchctl print answers 113 for a job it does not have; any other answer is not that.
    return [
      `launchctl bootout ${job} 2>/dev/null`,
      `i=0; while launchctl print ${job} >/dev/null 2>&1 && [ "$i" -lt ${wait} ]; do sleep 1; i=$((i + 1)); done`,
      `launchctl print ${job} >/dev/null 2>&1; status=$?`,
      `if [ "$status" -ne 113 ]; then if [ "$status" -eq 0 ]; then echo "launchd still has ${launchdLabel(role)} loaded; its plist is kept" >&2; else echo "could not tell whether launchd unloaded ${launchdLabel(role)} (launchctl print: exit $status); its plist is kept" >&2; fi; exit 1; fi`,
      `rm -f "$HOME/Library/LaunchAgents/${launchdLabel(role)}.plist"`,
    ].join("\n");
  }
  const ctl = scope === "system" ? "systemctl" : "systemctl --user";
  const dir = scope === "system" ? systemDir : '"$HOME/.config/systemd/user"';
  const units = unitFiles(role);
  // Only states systemd reported are trusted: a failed probe (no bus, say) prints none, and keeps the unit.
  return [
    `${ctl} disable --now ${units.join(" ")} 2>/dev/null`,
    ...units.map(
      (u) =>
        `state=$(${ctl} is-active ${u} 2>/dev/null); case "$state" in inactive|failed) ;; active|activating|deactivating|reloading) echo "${u} is still running; its unit is kept" >&2; exit 1 ;; *) echo "could not tell whether ${u} stopped (systemctl is-active: \${state:-no answer}); its unit is kept" >&2; exit 1 ;; esac\n` +
        `enabled=$(${ctl} is-enabled ${u} 2>/dev/null); case "$enabled" in disabled|static|not-found) ;; enabled|enabled-runtime|linked|linked-runtime|alias|indirect) echo "${u} is still enabled; its unit is kept" >&2; exit 1 ;; *) echo "could not tell whether ${u} is disabled (systemctl is-enabled: \${enabled:-no answer}); its unit is kept" >&2; exit 1 ;; esac`,
    ),
    `rm -f ${units.map((u) => `${dir}/${u}`).join(" ")}`,
    `${ctl} daemon-reload`,
  ].join("\n");
};

export interface FoundService {
  readonly role: string;
  readonly what: string;
  readonly scope: "user" | "system";
  readonly script: string;
}

/** T3 Fleet's services installed here, in both scopes. */
export const findServices = (
  home: string,
  platform: string,
  systemDir: string = SYSTEM_DIR,
  /** Seconds to wait for each to stop, instead of its own; for tests. */
  wait?: number,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false));
    const found: Array<FoundService> = [];
    for (const s of SERVICES) {
      if (platform === "darwin") {
        if (yield* exists(`${home}/Library/LaunchAgents/${launchdLabel(s.role)}.plist`))
          found.push({
            role: s.role,
            what: s.what,
            scope: "user",
            script: removeService(platform, "user", s.role, wait ?? s.wait),
          });
        continue;
      }
      for (const scope of ["user", "system"] as const) {
        const dir = scope === "system" ? systemDir : `${home}/.config/systemd/user`;
        let any = false;
        for (const u of unitFiles(s.role)) if (yield* exists(`${dir}/${u}`)) any = true;
        if (any)
          found.push({
            role: s.role,
            what: s.what,
            scope,
            script: removeService(platform, scope, s.role, wait ?? s.wait, systemDir),
          });
      }
    }
    return found;
  });

/** Runs one service's removal; fails with why. */
export const stopService = (service: FoundService, home: string) =>
  exec({
    command: "sh",
    args: ["-c", service.script],
    env: { HOME: home },
    extendEnv: true,
    timeout: Duration.minutes(3),
  }).pipe(
    Effect.flatMap((r) =>
      r.code === 0
        ? Effect.succeed(`stopped ${service.what}`)
        : Effect.fail(
            `${service.what}: ${(r.stderr.trim() || r.spawnError || (r.timedOut ? "timed out" : `exit ${r.code}`)).split("\n").at(-1) ?? ""}`,
          ),
    ),
  );
