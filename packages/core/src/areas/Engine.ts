/**
 * T3 Fleet itself, installed on each node, so timers and fixes there can run
 * it. The node's copy must be the controller's exact build; the fix streams
 * that build over the same ssh connection, so no release has to exist.
 *
 *   ~/.local/share/t3-fleet/t3-fleet.mjs   the bundle
 *   ~/.local/bin/t3-fleet                  link to it (and ~/.local/bin/fleetx until 1.0)
 *
 * A machine set up before the rename still has ~/.config/fleetx and the
 * rest (see Names.ts); the migration finding moves them over.
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
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { sha256 } from "../Hash.ts";
import {
  configDir,
  CONFIG_DIR,
  LEGACY_BUNDLE_FILE,
  LEGACY_CONFIG_DIR,
  LEGACY_SHARE_DIR,
  LEGACY_STATE_DIR,
  BUNDLE_FILE,
  launchdLabel,
  SH_CONFIG_DIR,
  SHARE_DIR,
  STATE_DIR,
  systemdUnit,
} from "../Names.ts";
import { installedBundle, legacyUnitInstalled, notInstalledTitle, retireLegacyUnit, stableNode } from "../Runtime.ts";

const Desired = Schema.UndefinedOr(
  Schema.Struct({ timer: Schema.optionalKey(Schema.Boolean), interval: Schema.optionalKey(Schema.Number) }),
);

const Observed = Schema.Struct({
  /** SHA-256 of the controller's build; null when not told (a local probe). */
  wanted: Schema.NullOr(Schema.String),
  installed: Schema.NullOr(Schema.String),
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
    /** Still installed under its fleetx name. Until 1.0. */
    legacy: Schema.optionalKey(Schema.Boolean),
  }),
  /** fleetx's directories still to move: config, state, share (Names.ts). Absent from older probes. */
  legacy: Schema.optionalKey(Schema.Array(Schema.Literals(["config", "state", "share"]))),
});

const LAUNCHD_LABEL = launchdLabel("sync");
const UNIT = systemdUnit("sync");

const timerPaths = (platform: string, root: boolean, home: string) =>
  platform === "darwin"
    ? { unit: `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`, timer: null }
    : root
      ? { unit: `/etc/systemd/system/${UNIT}.service`, timer: `/etc/systemd/system/${UNIT}.timer` }
      : { unit: `${home}/.config/systemd/user/${UNIT}.service`, timer: `${home}/.config/systemd/user/${UNIT}.timer` };

/** The unit (and timer) text; for systemd both files joined with a separator line. */
const timerUnits = (platform: string, home: string, nodePath: string, bundle: string, interval: number) => {
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

export const ENGINE_INSTALL = "t3-fleet:install-self";

const heredoc = (file: string, text: string) => `cat > ${file} <<'T3_FLEET_UNIT'\n${text.endsWith("\n") ? text : `${text}\n`}T3_FLEET_UNIT`;

const installTimer = (platform: string, root: boolean, want: string) => {
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`;
    return [
      retireLegacyUnit(platform, root, "sync"),
      `mkdir -p "$HOME/Library/LaunchAgents" "$HOME/${STATE_DIR}"`,
      heredoc(plist, want),
      `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" ${plist}`,
    ].join("\n");
  }
  const [service, timer] = want.split("--- timer ---\n");
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    retireLegacyUnit(platform, root, "sync"),
    `mkdir -p ${dir} "$HOME/${STATE_DIR}"`,
    heredoc(`${dir}/${UNIT}.service`, service ?? ""),
    heredoc(`${dir}/${UNIT}.timer`, timer ?? ""),
    ...(root ? [] : ['[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"']),
    `${ctl} daemon-reload && ${ctl} enable --now ${UNIT}.timer && ${ctl} restart ${UNIT}.timer`,
  ].join("\n");
};

const removeTimer = (platform: string, root: boolean) =>
  platform === "darwin"
    ? `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`
    : root
      ? `systemctl disable --now ${UNIT}.timer; rm -f /etc/systemd/system/${UNIT}.service /etc/systemd/system/${UNIT}.timer; systemctl daemon-reload`
      : `systemctl --user disable --now ${UNIT}.timer; rm -f "$HOME/.config/systemd/user/${UNIT}.service" "$HOME/.config/systemd/user/${UNIT}.timer"; systemctl --user daemon-reload`;

/**
 * Move fleetx's directories to T3 Fleet's, leaving links at the old names so
 * anything still using them (an old unit, a launcher, a user's script) keeps
 * working. A directory both names already have is merged, the new copy's
 * files winning, and the old one kept beside it. The bundle directory moves
 * once this build is installed, and its fleetx.mjs then names the new bundle.
 */
export const migrateDirs = (legacy: ReadonlyArray<"config" | "state" | "share">) => {
  const move = (was: string, now: string) =>
    [
      `if [ -d "$HOME/${was}" ] && [ ! -L "$HOME/${was}" ]; then`,
      // cp -n exits non-zero on macOS whenever it skips a file; the old directory is kept either way.
      `  if [ -e "$HOME/${now}" ]; then cp -Rpn "$HOME/${was}/." "$HOME/${now}/" 2>/dev/null; mv "$HOME/${was}" "$HOME/${was}.migrated.$(date +%Y%m%d%H%M%S)"`,
      `  else mkdir -p "$(dirname "$HOME/${now}")" && mv "$HOME/${was}" "$HOME/${now}"; fi`,
      `  [ -e "$HOME/${was}" ] || { ln -s "$HOME/${now}" "$HOME/${was}" && echo "moved ~/${was} to ~/${now}"; }`,
      "fi",
    ].join("\n");
  const steps: Array<string> = [];
  if (legacy.includes("config")) steps.push(move(LEGACY_CONFIG_DIR, CONFIG_DIR));
  if (legacy.includes("state")) steps.push(move(LEGACY_STATE_DIR, STATE_DIR));
  if (legacy.includes("share")) {
    steps.push(
      `if [ -f "$HOME/${SHARE_DIR}/${BUNDLE_FILE}" ]; then`,
      move(LEGACY_SHARE_DIR, SHARE_DIR),
      `  ln -sfn ${BUNDLE_FILE} "$HOME/${SHARE_DIR}/${LEGACY_BUNDLE_FILE}"`,
      "fi",
    );
  }
  return steps.join("\n");
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
      const bytes = Option.isSome(at) ? yield* fs.readFile(at.value).pipe(Effect.option) : Option.none();
      const installed = Option.isSome(bytes) ? yield* Effect.promise(() => sha256(bytes.value)) : null;
      let local: typeof Observed.Type["local"] = null;
      if (ctx.node !== null) {
        const checkout = ctx.checkout.startsWith(`${ctx.home}/`) ? `~${ctx.checkout.slice(ctx.home.length)}` : ctx.checkout;
        const want = `repo = "${checkout}"\nnode = "${ctx.node}"\n`;
        const have = yield* fs.readFileString(`${configDir(ctx.home)}/config.toml`).pipe(Effect.orElseSucceed(() => ""));
        const parsed = (key: string, text: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
        const expand = (p: string | undefined) => (p === undefined ? undefined : p.replace(/^~(?=\/|$)/, ctx.home));
        const matches = expand(parsed("repo", have)) === ctx.checkout && parsed("node", have) === ctx.node;
        local = { want, matches };
      }
      const platform = process.platform;
      const root = process.getuid?.() === 0;
      const paths = timerPaths(platform, root, ctx.home);
      const unitText = yield* fs.readFileString(paths.unit).pipe(Effect.option);
      const timerText = paths.timer === null ? Option.some("") : yield* fs.readFileString(paths.timer).pipe(Effect.option);
      const installedTimer =
        Option.isSome(unitText) && Option.isSome(timerText)
          ? paths.timer === null
            ? unitText.value
            : `${unitText.value}--- timer ---\n${timerText.value}`
          : null;
      const nodePath = yield* stableNode(ctx.home);
      const bundle = yield* installedBundle(ctx.home);
      const want = desired?.timer === true ? timerUnits(platform, ctx.home, nodePath, bundle, desired.interval ?? 900) : null;
      const check =
        platform === "darwin"
          ? yield* exec({ command: "launchctl", args: ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], timeout: Duration.seconds(5) })
          : yield* exec({
              command: "systemctl",
              args: [...(root ? [] : ["--user"]), "show", `${UNIT}.timer`, "-p", "ActiveState", "-p", "NextElapseUSecMonotonic", "-p", "NextElapseUSecRealtime"],
              timeout: Duration.seconds(5),
            });
      // An active timer can still have nothing scheduled (it "elapsed"): that one never runs again.
      const scheduled = (text: string) => {
        const prop = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
        const mono = prop("NextElapseUSecMonotonic");
        return prop("ActiveState") === "active" && ((mono !== "" && mono !== "infinity") || prop("NextElapseUSecRealtime") !== "");
      };
      const realDir = (rel: string) =>
        fs.readLink(`${ctx.home}/${rel}`).pipe(
          Effect.map(() => false),
          Effect.catch(() => fs.stat(`${ctx.home}/${rel}`).pipe(Effect.map((s) => s.type === "Directory"), Effect.orElseSucceed(() => false))),
        );
      const legacy: Array<"config" | "state" | "share"> = [];
      if (yield* realDir(LEGACY_CONFIG_DIR)) legacy.push("config");
      if (yield* realDir(LEGACY_STATE_DIR)) legacy.push("state");
      if (yield* realDir(LEGACY_SHARE_DIR)) legacy.push("share");
      return {
        legacy,
        wanted: ctx.engine,
        installed,
        local,
        platform,
        root,
        nodePath,
        timer: {
          installed: installedTimer,
          want,
          loaded: check.code === 0 && (platform === "darwin" || scheduled(check.stdout)),
          legacy: yield* legacyUnitInstalled(platform, root, ctx.home, "sync"),
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
        fix: { command: `d="${SH_CONFIG_DIR}" && mkdir -p "$d" && printf '%s' ${sh(observed.local.want)} > "$d/config.toml"`, safe: true },
      });
    }
    const t = observed.timer;
    if (t.want !== null && (t.installed !== t.want || !t.loaded)) {
      out.push({
        node,
        key: "engine-timer",
        severity: "warn",
        area: "engine",
        title: t.installed === null ? notInstalledTitle("sync timer", t.legacy) : t.installed !== t.want ? "the sync timer is out of date" : "the sync timer is not running",
        detail: `runs ${observed.nodePath} with a fixed PATH`,
        fix: { command: installTimer(observed.platform, observed.root, t.want), safe: true },
      });
    }
    if (t.want === null && t.installed !== null) {
      out.push({
        node,
        key: "engine-timer-unwanted",
        severity: "warn",
        area: "engine",
        title: "a sync timer is installed, but [engine] timer is not set for this machine",
        fix: { command: removeTimer(observed.platform, observed.root), safe: true },
      });
    }
    if (observed.wanted !== null && observed.installed !== observed.wanted) {
      out.push({
        node,
        key: "engine-outdated",
        severity: "warn",
        area: "engine",
        title: observed.installed === null ? "T3 Fleet is not installed here" : "T3 Fleet here is a different build than the controller's",
        detail: "timers and fixes on this machine run its own copy",
        fix: { command: ENGINE_INSTALL, safe: true },
      });
    }
    // After the install, so the bundle directory can move in the same run.
    const legacy = observed.legacy ?? [];
    if (legacy.length > 0) {
      out.push({
        node,
        key: "engine-legacy-dirs",
        severity: "warn",
        area: "engine",
        title: `fleetx's ${legacy.map((d) => `~/.${d === "config" ? "config" : `local/${d}`}/fleetx`).join(", ")} still to move to T3 Fleet's`,
        detail: "the old names stay as links to the new ones, so nothing using them breaks",
        fix: { command: migrateDirs(legacy), safe: true },
      });
    }
    return out;
  },
});
