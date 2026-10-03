/**
 * The relay's long-running pieces, when the fleet has a relay ([relay] in
 * fleetx.toml):
 *
 *   on the node with the relay role   `fleetx relay serve` as a service, its
 *                                     port published to the tailnet only
 *   on every other node               `fleetx listen` as a service, so it
 *                                     syncs as soon as the branch moves
 *
 * Services run the absolute node binary and bundle with a fixed PATH, like
 * the sync timer, and restart when they exit.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineArea } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { installedBundle, stableNode } from "../Runtime.ts";

const Observed = Schema.Struct({
  /** "serve", "listen", or null when this node runs neither. */
  role: Schema.NullOr(Schema.Literals(["serve", "listen"])),
  platform: Schema.String,
  root: Schema.Boolean,
  installed: Schema.NullOr(Schema.String),
  want: Schema.NullOr(Schema.String),
  running: Schema.Boolean,
  /** Relay node: whether the port is published on the tailnet. */
  published: Schema.NullOr(Schema.Boolean),
  port: Schema.Number,
});

const label = (role: string) => `dev.fleetx.${role}`;
const unitName = (role: string) => `fleetx-${role}`;

const unitPath = (platform: string, root: boolean, home: string, role: string) =>
  platform === "darwin"
    ? `${home}/Library/LaunchAgents/${label(role)}.plist`
    : root
      ? `/etc/systemd/system/${unitName(role)}.service`
      : `${home}/.config/systemd/user/${unitName(role)}.service`;

const unitText = (platform: string, root: boolean, home: string, nodePath: string, bundle: string, role: "serve" | "listen") => {
  const args = role === "serve" ? ["relay", "serve"] : ["listen"];
  const path = `${home}/.local/bin:${platform === "darwin" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`;
  const log = `${home}/.local/state/fleetx/${role}.log`;
  if (platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label(role)}</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${bundle}</string>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>HOME</key><string>${home}</string><key>NO_COLOR</key><string>1</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
  }
  return `[Unit]
Description=fleetx ${role === "serve" ? "relay" : "listener"}
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=${home}
Environment=PATH=${path}
Environment=NO_COLOR=1
ExecStart=${nodePath} ${bundle} ${args.join(" ")}
Restart=always
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=${root ? "multi-user.target" : "default.target"}
`;
};

const install = (platform: string, root: boolean, role: "serve" | "listen", text: string) => {
  const write = (file: string) => `cat > ${file} <<'FLEETX_UNIT'\n${text}FLEETX_UNIT`;
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${label(role)}.plist"`;
    return [
      'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state/fleetx"',
      write(plist),
      `launchctl bootout "gui/$(id -u)/${label(role)}" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" ${plist}`,
    ].join("\n");
  }
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    `mkdir -p ${dir} "$HOME/.local/state/fleetx"`,
    write(`${dir}/${unitName(role)}.service`),
    ...(root ? [] : ['[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"']),
    `${ctl} daemon-reload && ${ctl} enable ${unitName(role)}.service && ${ctl} restart ${unitName(role)}.service`,
  ].join("\n");
};

export const RelayArea = defineArea({
  id: "relay",
  description: "the relay service on the relay node, and a listener on every other node",
  desired: Schema.Unknown,
  observed: Observed,
  observe: (_desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const platform = process.platform;
      const root = process.getuid?.() === 0;
      const port = ctx.relay?.port ?? 8399;
      const role = ctx.relay === null ? null : ctx.roles.includes("relay") ? ("serve" as const) : ctx.relay.url === null ? null : ("listen" as const);
      if (role === null) return { role, platform, root, installed: null, want: null, running: false, published: null, port };
      const installed = Option.getOrNull(yield* fs.readFileString(unitPath(platform, root, ctx.home, role)).pipe(Effect.option));
      const want = unitText(platform, root, ctx.home, yield* stableNode(ctx.home), yield* installedBundle(ctx.home), role);
      const check =
        platform === "darwin"
          ? yield* exec({ command: "launchctl", args: ["print", `gui/${process.getuid?.() ?? 0}/${label(role)}`], timeout: Duration.seconds(5) })
          : yield* exec({ command: "systemctl", args: [...(root ? [] : ["--user"]), "is-active", "--quiet", `${unitName(role)}.service`], timeout: Duration.seconds(5) });
      const running = platform === "darwin" ? check.code === 0 && /state = running/.test(check.stdout) : check.code === 0;
      let published: boolean | null = null;
      if (role === "serve") {
        const serve = yield* exec({ command: "tailscale", args: ["serve", "status"], env: ctx.env, timeout: Duration.seconds(10) });
        published = serve.code === 0 && serve.stdout.includes(`:${port}`) && serve.stdout.includes(`127.0.0.1:${port}`);
      }
      return { role, platform, root, installed, want, running, published, port };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (observed.role === null || observed.want === null) return out;
    const what = observed.role === "serve" ? "relay" : "relay listener";
    if (observed.installed !== observed.want || !observed.running) {
      out.push({
        node,
        key: `relay-${observed.role}`,
        severity: "warn",
        area: "relay",
        title: observed.installed === null ? `the ${what} is not installed` : observed.installed !== observed.want ? `the ${what} is out of date` : `the ${what} is not running`,
        fix: { command: install(observed.platform, observed.root, observed.role, observed.want), safe: true },
      });
    }
    if (observed.role === "serve" && observed.published === false) {
      out.push({
        node,
        key: "relay-unpublished",
        severity: "warn",
        area: "relay",
        title: `the relay's port ${observed.port} is not published to the tailnet`,
        fix: { command: `tailscale serve --bg --https=${observed.port} http://127.0.0.1:${observed.port}`, safe: true },
      });
    }
    return out;
  },
});
