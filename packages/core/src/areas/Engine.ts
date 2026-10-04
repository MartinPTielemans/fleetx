/**
 * T3 Fleet itself, installed on each node, so timers and fixes there can run
 * it. The node's copy must be the controller's exact build; the fix streams
 * that build over the same ssh connection, so no release has to exist. It is
 * only offered when the controller's build is the newer one (Build.ts): an
 * older controller says so instead of putting its build back.
 *
 *   ~/.local/share/t3-fleet/t3-fleet.mjs   the bundle
 *   ~/.local/bin/t3-fleet                  link to it
 *
 * And, when `[engine] timer = true`, the timer that runs `t3-fleet sync` every
 * `[engine] interval` seconds (launchd on macOS, systemd elsewhere; system
 * units for root). The unit runs the absolute node binary and bundle, with a
 * fixed PATH, so it never depends on what a login shell happens to set up.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineArea, sh } from "../Area.ts";
import { BuildId, buildOf, compareBuilds, describeBuild } from "../Build.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { sha256 } from "../Hash.ts";
import { configDir, launchdLabel, SH_CONFIG_DIR, STATE_DIR, systemdUnit } from "../Names.ts";
import { installedBundle, launchdReload, stableNode } from "../Runtime.ts";

const Desired = Schema.UndefinedOr(
  Schema.Struct({
    timer: Schema.optionalKey(Schema.Boolean),
    interval: Schema.optionalKey(Schema.Number),
  }),
);

const Observed = Schema.Struct({
  /** SHA-256 of the controller's build; null when not told (a local probe). */
  wanted: Schema.NullOr(Schema.String),
  installed: Schema.NullOr(Schema.String),
  /** Which builds those are; null for one from before builds had identities. Absent from older probes. */
  wantedBuild: Schema.optionalKey(Schema.NullOr(BuildId)),
  installedBuild: Schema.optionalKey(Schema.NullOr(BuildId)),
  /**
   * T3 Fleet's services installed here that installing a build restarts,
   * cutting what they carry. The model proxy is not one: it drains on its own.
   * Absent from older probes.
   */
  services: Schema.optionalKey(Schema.Array(Schema.Literals(["serve", "listen"]))),
  /** What ~/.config/t3-fleet/config.toml should say, and whether it does. */
  local: Schema.NullOr(Schema.Struct({ want: Schema.String, matches: Schema.Boolean })),
  platform: Schema.String,
  root: Schema.Boolean,
  /** The node binary running this probe: what the timer will run. */
  nodePath: Schema.String,
  /** The installed unit's content, if any, and what it should be. */
  timer: Schema.Struct({
    installed: Schema.NullOr(Schema.String),
    want: Schema.NullOr(Schema.String),
    loaded: Schema.Boolean,
    /**
     * This probe runs inside the timer's own launchd job (a sync it started),
     * where its fixes run too. Only launchd's main process sees its label in
     * XPC_SERVICE_NAME; the fix's shell sees "0", so it is noted here.
     */
    inJob: Schema.optionalKey(Schema.Boolean),
    /** A reload deferred by an earlier sync (see outsideSyncJob) has not run. */
    reloadPending: Schema.optionalKey(Schema.Boolean),
  }),
});

const LAUNCHD_LABEL = launchdLabel("sync");
const UNIT = systemdUnit("sync");

const timerPaths = (platform: string, root: boolean, home: string) =>
  platform === "darwin"
    ? { unit: `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`, timer: null }
    : root
      ? { unit: `/etc/systemd/system/${UNIT}.service`, timer: `/etc/systemd/system/${UNIT}.timer` }
      : {
          unit: `${home}/.config/systemd/user/${UNIT}.service`,
          timer: `${home}/.config/systemd/user/${UNIT}.timer`,
        };

/** The unit (and timer) text; for systemd both files joined with a separator line. */
const timerUnits = (
  platform: string,
  home: string,
  nodePath: string,
  bundle: string,
  interval: number,
) => {
  const path = `${home}/.local/bin:${platform === "darwin" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`;
  const log = `${home}/${STATE_DIR}/sync.log`;
  if (platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${bundle}</string><string>sync</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>HOME</key><string>${home}</string><key>NO_COLOR</key><string>1</string></dict>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
  }
  return `[Unit]
Description=T3 Fleet sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=HOME=${home}
Environment=PATH=${path}
Environment=NO_COLOR=1
ExecStart=${nodePath} ${bundle} sync
StandardOutput=append:${log}
StandardError=append:${log}
Nice=10
--- timer ---
[Unit]
Description=Run T3 Fleet sync every ${interval}s

[Timer]
# OnActiveSec starts the chain when the timer is (re)installed after its
# service already ran; without it OnUnitActiveSec never fires again.
OnActiveSec=1min
OnBootSec=2min
OnUnitActiveSec=${interval}s
Persistent=true

[Install]
WantedBy=timers.target
`;
};

/**
 * Whether a systemd timer, from `systemctl show <unit>.timer`, will run its
 * service again. An active timer can still have nothing scheduled (it
 * "elapsed"): that one never runs again. While its service is running, as
 * when a sync observes its own timer, it has nothing scheduled either, but
 * schedules the next run once that one ends; taking it for elapsed made each
 * sync reinstall its timer, and run again a minute later.
 */
export const systemdTimerScheduled = (text: string) => {
  const prop = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const mono = prop("NextElapseUSecMonotonic");
  return (
    prop("ActiveState") === "active" &&
    (prop("SubState") === "running" ||
      (mono !== "" && mono !== "infinity") ||
      prop("NextElapseUSecRealtime") !== "")
  );
};

export const ENGINE_INSTALL = "t3-fleet:install-self";

const heredoc = (file: string, text: string) =>
  `cat > ${file} <<'T3_FLEET_UNIT'\n${text.endsWith("\n") ? text : `${text}\n`}T3_FLEET_UNIT`;

/** Left by a deferred reload until it runs; holds the pid of the sync that deferred it. */
export const RELOAD_PENDING = "sync-timer-reload.pending";

/**
 * launchctl steps that stop the sync timer's job, for a fix that runs inside
 * it: a sync the timer started runs its fixes in that job, and bootout stops
 * the job's processes, the fix's shell with them, before the next step runs,
 * leaving the Mac with no timer. Those steps go to a helper in its own
 * session (a file of its own, so two never share one), which waits for the
 * sync (the shell's parent) to exit first. Until the steps have run, a marker
 * says a reload is pending; a failed reload puts it back.
 */
export const outsideSyncJob = (nodePath: string, steps: string) => {
  const marker = `"$HOME/${STATE_DIR}/${RELOAD_PENDING}"`;
  return [
    `mkdir -p "$HOME/${STATE_DIR}" && helper=$(mktemp "$HOME/${STATE_DIR}/sync-timer-reload.XXXXXX") && echo "$PPID" > ${marker}`,
    heredoc(
      '"$helper"',
      `i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 600 ]; do sleep 1; i=$((i+1)); done\nrm -f ${marker}\n{\n${steps}\n} || echo "$1" > ${marker}\nrm -f "$0"`,
    ),
    `${sh(nodePath)} -e 'require("node:child_process").spawn("/bin/sh", process.argv.slice(1), { detached: true, stdio: "ignore" }).unref()' "$helper" "$PPID"`,
    `echo "the sync timer reloads once this sync finishes"`,
  ].join("\n");
};

/** The launchctl steps as they run: now, or, inside the timer's own job, once its sync has exited. */
const launchctlSteps = (inJob: boolean, nodePath: string, steps: string) =>
  inJob ? outsideSyncJob(nodePath, steps) : steps;

const installTimer = (
  platform: string,
  root: boolean,
  want: string,
  inJob: boolean,
  nodePath: string,
) => {
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`;
    return [
      `mkdir -p "$HOME/Library/LaunchAgents" "$HOME/${STATE_DIR}"`,
      heredoc(plist, want),
      launchctlSteps(
        inJob,
        nodePath,
        // The plist sets no ExitTimeOut, so launchd's default applies.
        launchdReload(LAUNCHD_LABEL, plist),
      ),
    ].join("\n");
  }
  const [service, timer] = want.split("--- timer ---\n");
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    `mkdir -p ${dir} "$HOME/${STATE_DIR}"`,
    heredoc(`${dir}/${UNIT}.service`, service ?? ""),
    heredoc(`${dir}/${UNIT}.timer`, timer ?? ""),
    ...(root
      ? []
      : [
          '[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"',
        ]),
    `${ctl} daemon-reload && ${ctl} enable --now ${UNIT}.timer && ${ctl} restart ${UNIT}.timer`,
  ].join("\n");
};

/** Remove the timer. On macOS the launchctl steps run as one, so a fix inside the job starts a single helper. */
const removeTimer = (platform: string, root: boolean, inJob: boolean, nodePath: string) => {
  if (platform === "darwin") {
    return `rm -f "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"\n${launchctlSteps(inJob, nodePath, `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null`)}`;
  }
  return root
    ? `systemctl disable --now ${UNIT}.timer; rm -f /etc/systemd/system/${UNIT}.service /etc/systemd/system/${UNIT}.timer; systemctl daemon-reload`
    : `systemctl --user disable --now ${UNIT}.timer; rm -f "$HOME/.config/systemd/user/${UNIT}.service" "$HOME/.config/systemd/user/${UNIT}.timer"; systemctl --user daemon-reload`;
};

const SERVICE_NAMES: Readonly<Record<"serve" | "listen", string>> = {
  serve: "the relay",
  listen: "the listener",
};

/**
 * The installed build differs from the controller's. Installing the
 * controller's is only right when it is the newer one; a node ahead of the
 * controller means the controller needs upgrading, not the node downgrading.
 * A build without an identity predates identities, so it is the older one.
 */
const engineFinding = (node: string, observed: typeof Observed.Type): Finding => {
  const wanted = observed.wantedBuild ?? null;
  const installed = observed.installedBuild ?? null;
  // null: neither is known to be newer.
  const order =
    observed.installed === null
      ? 1
      : wanted === null
        ? installed === null
          ? null
          : -1
        : installed === null
          ? 1
          : compareBuilds(wanted, installed);
  const here = installed === null ? "" : ` (${describeBuild(installed)})`;
  const controller = wanted === null ? "" : ` (${describeBuild(wanted)})`;
  if (order !== null && order < 0) {
    return {
      node,
      key: "engine-newer-here",
      severity: "warn",
      area: "engine",
      title: `T3 Fleet here is a newer build${here} than the controller's${controller}`,
      detail:
        "upgrade T3 Fleet on the machine you run it from; installing the controller's build here would downgrade this machine",
    };
  }
  const services = observed.services ?? [];
  const install = {
    command: ENGINE_INSTALL,
    // Asked first unless the controller's build is known to be the newer one.
    safe: order !== null && order > 0,
    ...(services.length === 0
      ? {}
      : {
          disrupts: `restarts ${services
            .map((s) => SERVICE_NAMES[s])
            .join(", ")
            .replace(/, ([^,]*)$/, " and $1")} on ${node}`,
        }),
  };
  const sameVersion = wanted !== null && installed !== null && wanted.version === installed.version;
  return {
    node,
    key: "engine-outdated",
    severity: "warn",
    area: "engine",
    title:
      observed.installed === null
        ? "T3 Fleet is not installed here"
        : order !== null && order > 0
          ? `T3 Fleet here is an older build${here} than the controller's${controller}`
          : `T3 Fleet here is a different build${here} than the controller's${controller}, and neither is known to be newer`,
    detail:
      order === null
        ? sameVersion
          ? "both are the same version built from different commits, so installing the controller's could take this machine back; install it only if the controller has the build you want"
          : "one of the builds does not say what it is; install the controller's only if it has the build you want"
        : "timers and fixes on this machine run its own copy",
    fix: install,
  };
};

export const EngineArea = defineArea({
  id: "engine",
  description: "this build of T3 Fleet installed on every node",
  desired: Desired,
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = yield* installedBundle(ctx.home).pipe(Effect.map(Option.some));
      const bytes = Option.isSome(at)
        ? yield* fs.readFile(at.value).pipe(Effect.option)
        : Option.none();
      const installed = Option.isSome(bytes)
        ? yield* Effect.promise(() => sha256(bytes.value))
        : null;
      const installedBuild = Option.isSome(bytes)
        ? buildOf(new TextDecoder().decode(bytes.value))
        : null;
      let local: (typeof Observed.Type)["local"] = null;
      if (ctx.node !== null) {
        const checkout = ctx.checkout.startsWith(`${ctx.home}/`)
          ? `~${ctx.checkout.slice(ctx.home.length)}`
          : ctx.checkout;
        const want = `repo = "${checkout}"\nnode = "${ctx.node}"\n`;
        const have = yield* fs
          .readFileString(`${configDir(ctx.home)}/config.toml`)
          .pipe(Effect.orElseSucceed(() => ""));
        const parsed = (key: string, text: string) =>
          new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
        const expand = (p: string | undefined) =>
          p === undefined ? undefined : p.replace(/^~(?=\/|$)/, ctx.home);
        const matches =
          expand(parsed("repo", have)) === ctx.checkout && parsed("node", have) === ctx.node;
        local = { want, matches };
      }
      const platform = process.platform;
      const root = process.getuid?.() === 0;
      const paths = timerPaths(platform, root, ctx.home);
      const unitText = yield* fs.readFileString(paths.unit).pipe(Effect.option);
      const timerText =
        paths.timer === null
          ? Option.some("")
          : yield* fs.readFileString(paths.timer).pipe(Effect.option);
      const installedTimer =
        Option.isSome(unitText) && Option.isSome(timerText)
          ? paths.timer === null
            ? unitText.value
            : `${unitText.value}--- timer ---\n${timerText.value}`
          : null;
      const nodePath = yield* stableNode(ctx.home);
      const bundle = yield* installedBundle(ctx.home);
      const want =
        desired?.timer === true
          ? timerUnits(platform, ctx.home, nodePath, bundle, desired.interval ?? 900)
          : null;
      const check =
        platform === "darwin"
          ? yield* exec({
              command: "launchctl",
              args: ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`],
              timeout: Duration.seconds(5),
            })
          : yield* exec({
              command: "systemctl",
              args: [
                ...(root ? [] : ["--user"]),
                "show",
                `${UNIT}.timer`,
                "-p",
                "ActiveState",
                "-p",
                "SubState",
                "-p",
                "NextElapseUSecMonotonic",
                "-p",
                "NextElapseUSecRealtime",
              ],
              timeout: Duration.seconds(5),
            });
      const services: Array<"serve" | "listen"> = [];
      for (const role of ["serve", "listen"] as const) {
        const unit =
          platform === "darwin"
            ? `${ctx.home}/Library/LaunchAgents/${launchdLabel(role)}.plist`
            : root
              ? `/etc/systemd/system/${systemdUnit(role)}.service`
              : `${ctx.home}/.config/systemd/user/${systemdUnit(role)}.service`;
        if (yield* fs.exists(unit).pipe(Effect.orElseSucceed(() => false))) services.push(role);
      }
      // A pending reload's marker names the sync that deferred it: this one (its fix just ran) or one still running is not stuck.
      const pendingPid = yield* fs
        .readFileString(`${ctx.home}/${STATE_DIR}/${RELOAD_PENDING}`)
        .pipe(
          Effect.map((text) => Number(text.trim())),
          Effect.option,
        );
      const reloadPending =
        Option.isSome(pendingPid) &&
        pendingPid.value !== process.pid &&
        !(
          pendingPid.value > 0 &&
          (yield* exec({
            command: "ps",
            args: ["-p", String(pendingPid.value), "-o", "pid="],
            timeout: Duration.seconds(5),
          })).stdout.trim() !== ""
        );
      return {
        wanted: ctx.engine,
        installed,
        wantedBuild: ctx.engine === null ? null : ctx.engineBuild,
        installedBuild,
        services,
        local,
        platform,
        root,
        nodePath,
        timer: {
          installed: installedTimer,
          want,
          loaded:
            check.code === 0 && (platform === "darwin" || systemdTimerScheduled(check.stdout)),
          reloadPending,
          inJob: platform === "darwin" && ctx.env["XPC_SERVICE_NAME"] === LAUNCHD_LABEL,
        },
      };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (observed.local !== null && !observed.local.matches) {
      out.push({
        node,
        key: "engine-local-config",
        severity: "warn",
        area: "engine",
        title: "~/.config/t3-fleet/config.toml does not name this machine and its config repo",
        // Not safe: which repo this machine uses is a person's choice (join --dir), and a wrong one stops every sync.
        fix: {
          command: `d="${SH_CONFIG_DIR}" && mkdir -p "$d" && printf '%s' ${sh(observed.local.want)} > "$d/config.toml"`,
          safe: false,
        },
      });
    }
    const t = observed.timer;
    // A reload deferred to after an earlier sync that never ran (the helper failed, or the Mac slept): launchd still has the old job.
    const stuck = t.reloadPending === true;
    if (t.want !== null && (t.installed !== t.want || !t.loaded || stuck)) {
      out.push({
        node,
        key: "engine-timer",
        severity: "warn",
        area: "engine",
        title:
          t.installed === null
            ? "the sync timer is not installed"
            : t.installed !== t.want
              ? "the sync timer is out of date"
              : !t.loaded
                ? "the sync timer is not running"
                : "the sync timer was changed, but launchd never reloaded it",
        detail: `runs ${observed.nodePath} with a fixed PATH`,
        fix: {
          command: installTimer(
            observed.platform,
            observed.root,
            t.want,
            t.inJob === true,
            observed.nodePath,
          ),
          safe: true,
        },
      });
    }
    if (t.want === null && (t.installed !== null || stuck)) {
      out.push({
        node,
        key: "engine-timer-unwanted",
        severity: "warn",
        area: "engine",
        title:
          t.installed !== null
            ? "a sync timer is installed, but [engine] timer is not set for this machine"
            : "the sync timer was removed, but launchd still has it loaded",
        fix: {
          command: removeTimer(
            observed.platform,
            observed.root,
            t.inJob === true,
            observed.nodePath,
          ),
          safe: true,
        },
      });
    }
    if (observed.wanted !== null && observed.installed !== observed.wanted) {
      out.push(engineFinding(node, observed));
    }
    return out;
  },
});
