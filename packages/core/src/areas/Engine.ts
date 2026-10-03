/**
 * fleetx itself, installed on each node, so timers and fixes there can run
 * it. The node's copy must be the controller's exact build; the fix streams
 * that build over the same ssh connection, so no release has to exist.
 *
 *   ~/.local/share/fleetx/fleetx.mjs   the bundle
 *   ~/.local/bin/fleetx                link to it
 *
 * and, when `[engine] timer = true`, the timer that runs `fleetx sync` every
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

const Desired = Schema.UndefinedOr(
  Schema.Struct({ timer: Schema.optionalKey(Schema.Boolean), interval: Schema.optionalKey(Schema.Number) }),
);

const Observed = Schema.Struct({
  /** SHA-256 of the controller's build; null when not told (a local probe). */
  wanted: Schema.NullOr(Schema.String),
  installed: Schema.NullOr(Schema.String),
  /** What ~/.config/fleetx/config.toml should say, and whether it does. */
  local: Schema.NullOr(Schema.Struct({ want: Schema.String, matches: Schema.Boolean })),
  platform: Schema.String,
  root: Schema.Boolean,
  /** The node binary running this probe: what the timer will run. */
  nodePath: Schema.String,
  /** The installed unit's content, if any, and what it should be. */
  timer: Schema.Struct({ installed: Schema.NullOr(Schema.String), want: Schema.NullOr(Schema.String), loaded: Schema.Boolean }),
});

const LAUNCHD_LABEL = "dev.fleetx.sync";

const timerPaths = (platform: string, root: boolean, home: string) =>
  platform === "darwin"
    ? { unit: `${home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`, timer: null }
    : root
      ? { unit: "/etc/systemd/system/fleetx-sync.service", timer: "/etc/systemd/system/fleetx-sync.timer" }
      : { unit: `${home}/.config/systemd/user/fleetx-sync.service`, timer: `${home}/.config/systemd/user/fleetx-sync.timer` };

/** The unit (and timer) text; for systemd both files joined with a separator line. */
const timerUnits = (platform: string, home: string, nodePath: string, interval: number) => {
  const bundle = `${home}/.local/share/fleetx/fleetx.mjs`;
  const path = `${home}/.local/bin:${platform === "darwin" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`;
  const log = `${home}/.local/state/fleetx/sync.log`;
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
Description=fleetx sync
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
Description=Run fleetx sync every ${interval}s

[Timer]
OnBootSec=2min
OnUnitActiveSec=${interval}s
Persistent=true

[Install]
WantedBy=timers.target
`;
};

export const ENGINE_INSTALL = "fleetx:install-self";

const heredoc = (file: string, text: string) => `cat > ${file} <<'FLEETX_UNIT'\n${text.endsWith("\n") ? text : `${text}\n`}FLEETX_UNIT`;

const installTimer = (platform: string, root: boolean, want: string) => {
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`;
    return [
      'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state/fleetx"',
      heredoc(plist, want),
      `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" ${plist}`,
    ].join("\n");
  }
  const [service, timer] = want.split("--- timer ---\n");
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    `mkdir -p ${dir} "$HOME/.local/state/fleetx"`,
    heredoc(`${dir}/fleetx-sync.service`, service ?? ""),
    heredoc(`${dir}/fleetx-sync.timer`, timer ?? ""),
    ...(root ? [] : ['[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"']),
    `${ctl} daemon-reload && ${ctl} enable --now fleetx-sync.timer && ${ctl} restart fleetx-sync.timer`,
  ].join("\n");
};

const removeTimer = (platform: string, root: boolean) =>
  platform === "darwin"
    ? `launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null; rm -f "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"`
    : root
      ? "systemctl disable --now fleetx-sync.timer; rm -f /etc/systemd/system/fleetx-sync.service /etc/systemd/system/fleetx-sync.timer; systemctl daemon-reload"
      : 'systemctl --user disable --now fleetx-sync.timer; rm -f "$HOME/.config/systemd/user/fleetx-sync.service" "$HOME/.config/systemd/user/fleetx-sync.timer"; systemctl --user daemon-reload';

export const EngineArea = defineArea({
  id: "engine",
  description: "this build of fleetx installed on every node",
  desired: Desired,
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = yield* fs.realPath(`${ctx.home}/.local/bin/fleetx`).pipe(Effect.option);
      const bytes = Option.isSome(at) ? yield* fs.readFile(at.value).pipe(Effect.option) : Option.none();
      const installed = Option.isSome(bytes) ? yield* Effect.promise(() => sha256(bytes.value)) : null;
      let local: typeof Observed.Type["local"] = null;
      if (ctx.node !== null) {
        const checkout = ctx.checkout.startsWith(`${ctx.home}/`) ? `~${ctx.checkout.slice(ctx.home.length)}` : ctx.checkout;
        const want = `repo = "${checkout}"\nnode = "${ctx.node}"\n`;
        const have = yield* fs.readFileString(`${ctx.home}/.config/fleetx/config.toml`).pipe(Effect.orElseSucceed(() => ""));
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
      const want = desired?.timer === true ? timerUnits(platform, ctx.home, process.execPath, desired.interval ?? 900) : null;
      const check =
        platform === "darwin"
          ? yield* exec({ command: "launchctl", args: ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`], timeout: Duration.seconds(5) })
          : yield* exec({ command: "systemctl", args: [...(root ? [] : ["--user"]), "is-active", "--quiet", "fleetx-sync.timer"], timeout: Duration.seconds(5) });
      return {
        wanted: ctx.engine,
        installed,
        local,
        platform,
        root,
        nodePath: process.execPath,
        timer: { installed: installedTimer, want, loaded: check.code === 0 },
      };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (observed.local !== null && !observed.local.matches) {
      out.push({
        node,
        key: "fleetx-local-config",
        severity: "warn",
        area: "engine",
        title: "~/.config/fleetx/config.toml does not name this machine and its config repo",
        fix: { command: `mkdir -p ~/.config/fleetx && printf '%s' ${sh(observed.local.want)} > ~/.config/fleetx/config.toml`, safe: true },
      });
    }
    const t = observed.timer;
    if (t.want !== null && (t.installed !== t.want || !t.loaded)) {
      out.push({
        node,
        key: "fleetx-timer",
        severity: "warn",
        area: "engine",
        title: t.installed === null ? "the fleetx sync timer is not installed" : t.installed !== t.want ? "the fleetx sync timer is out of date" : "the fleetx sync timer is not running",
        detail: `runs ${observed.nodePath} with a fixed PATH`,
        fix: { command: installTimer(observed.platform, observed.root, t.want), safe: true },
      });
    }
    if (t.want === null && t.installed !== null) {
      out.push({
        node,
        key: "fleetx-timer-unwanted",
        severity: "warn",
        area: "engine",
        title: "a fleetx sync timer is installed, but [engine] timer is not set for this machine",
        fix: { command: removeTimer(observed.platform, observed.root), safe: true },
      });
    }
    if (observed.wanted === null || observed.installed === observed.wanted) return out;
    out.push({
      node,
      key: "fleetx-outdated",
      severity: "warn",
      area: "engine",
      title: observed.installed === null ? "fleetx is not installed here" : "fleetx here is a different build than the controller's",
      detail: "timers and fixes on this machine run its own copy",
      fix: { command: ENGINE_INSTALL, safe: true },
    });
    return out;
  },
});
