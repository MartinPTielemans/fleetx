/**
 * What the models area installs on a node: the proxy service and two
 * launchers. T3's provider instances point at a launcher instead of the CLI;
 * the launcher runs the managed CLI pointed at the proxy.
 *
 * A launcher must never be the reason a provider fails. When the proxy is not
 * listening it runs the CLI directly and writes a line to
 * ~/.local/state/fleetx/models-fallback.log, which the proxy's stats and the
 * area report. Subcommands that make no model call (`--version`, login and
 * auth) skip the proxy, so T3's own checks and the probe's `claude auth
 * status` neither need it nor count as fallbacks.
 *
 *   fleetx-claude   loads the setup-token from ~/.config/fleetx/secrets.env
 *                   as CLAUDE_CODE_OAUTH_TOKEN when the environment has none,
 *                   and sets ANTHROPIC_BASE_URL to the proxy
 *   fleetx-codex    passes `-c openai_base_url=…`, which keeps Codex's
 *                   built-in OpenAI provider (and its login) and only moves
 *                   where it sends requests
 */
import { MODELS_PORT } from "./Proxy.ts";

export type LauncherName = "claude" | "codex";

export const launcherPath = (home: string, name: LauncherName) => `${home}/.local/bin/fleetx-${name}`;

/** Which launcher a T3 provider driver uses; null for drivers the proxy does not serve. */
export const launcherForDriver = (driver: string): LauncherName | null =>
  driver === "claudeAgent" ? "claude" : driver === "codex" ? "codex" : null;

const header = (name: LauncherName) => `#!/bin/sh
# fleetx-${name}: ${name === "claude" ? "Claude Code" : "Codex"} through the fleetx model proxy, or directly when the
# proxy is not listening. Written by fleetx's models area; edits are replaced.
cli="$HOME/.local/bin/${name}"
proxy="http://127.0.0.1:${MODELS_PORT}"
`;

const fallback = (upstream: "anthropic" | "openai") => `
listening() { command -v curl >/dev/null 2>&1 && curl -fsS -m 1 "$proxy/health" >/dev/null 2>&1; }
fell_back() {
  log="$HOME/.local/state/fleetx/models-fallback.log"
  mkdir -p "$HOME/.local/state/fleetx" 2>/dev/null
  if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 65536 ]; then mv -f "$log" "$log.1"; fi
  printf '%s\\t${upstream}\\t%s\\n' "$(date +%s)" "$1" >> "$log" 2>/dev/null
}
`;

export const claudeLauncher = (tokenEnv: string) => `${header("claude")}
# A setup-token does not rotate, so concurrent sessions cannot log each other out.
if [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "$HOME/.config/fleetx/secrets.env" ]; then
  token=$(sed -n 's/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}${tokenEnv}=//p' "$HOME/.config/fleetx/secrets.env" | tail -n 1)
  token=\${token#\\"}; token=\${token%\\"}
  if [ -n "$token" ]; then export CLAUDE_CODE_OAUTH_TOKEN="$token"; fi
fi
case "\${1:-}" in
  -v|--version|auth|setup-token|update|doctor) exec "$cli" "$@" ;;
esac
${fallback("anthropic")}
if listening; then
  export ANTHROPIC_BASE_URL="$proxy/anthropic"
  exec "$cli" "$@"
fi
fell_back "proxy not listening"
exec "$cli" "$@"
`;

export const codexLauncher = () => `${header("codex")}
case "\${1:-}" in
  -V|--version|login|logout) exec "$cli" "$@" ;;
esac
${fallback("openai")}
if listening; then
  exec "$cli" -c "openai_base_url=\\"$proxy/openai\\"" "$@"
fi
fell_back "proxy not listening"
exec "$cli" "$@"
`;

export const launcherText = (name: LauncherName, tokenEnv: string) => (name === "claude" ? claudeLauncher(tokenEnv) : codexLauncher());

// ---- the service -----------------------------------------------------------

export const SERVICE_LABEL = "dev.fleetx.models";
export const SERVICE_UNIT = "fleetx-models";

export const serviceUnitPath = (platform: string, root: boolean, home: string) =>
  platform === "darwin"
    ? `${home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`
    : root
      ? `/etc/systemd/system/${SERVICE_UNIT}.service`
      : `${home}/.config/systemd/user/${SERVICE_UNIT}.service`;

/**
 * `fleetx models serve` with the absolute node and bundle and a fixed PATH,
 * restarted when it exits (like the relay's units). Egress is an argument, so
 * changing it makes the unit stale and its fix restarts the proxy.
 */
export const serviceUnitText = (platform: string, root: boolean, home: string, nodePath: string, bundle: string, egress: "direct" | "relay" = "direct") => {
  const args = ["models", "serve", ...(egress === "relay" ? ["--egress", "relay"] : [])];
  const path = `${home}/.local/bin:${platform === "darwin" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`;
  const log = `${home}/.local/state/fleetx/models.log`;
  if (platform === "darwin") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${bundle}</string>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string><key>HOME</key><string>${home}</string><key>NO_COLOR</key><string>1</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
  }
  return `[Unit]
Description=fleetx model proxy
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=${home}
Environment=PATH=${path}
Environment=NO_COLOR=1
ExecStart=${nodePath} ${bundle} ${args.join(" ")}
Restart=always
RestartSec=10
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=${root ? "multi-user.target" : "default.target"}
`;
};

/** Shell that writes the unit and (re)starts it. */
export const serviceInstall = (platform: string, root: boolean, text: string) => {
  const write = (file: string) => `cat > ${file} <<'FLEETX_UNIT'\n${text}FLEETX_UNIT`;
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"`;
    return [
      'mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state/fleetx"',
      write(plist),
      `launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" ${plist}`,
    ].join("\n");
  }
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    `mkdir -p ${dir} "$HOME/.local/state/fleetx"`,
    write(`${dir}/${SERVICE_UNIT}.service`),
    ...(root ? [] : ['[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"']),
    `${ctl} daemon-reload && ${ctl} enable ${SERVICE_UNIT}.service && ${ctl} restart ${SERVICE_UNIT}.service`,
  ].join("\n");
};

/** Shell that writes a launcher, executable. */
export const launcherInstall = (name: LauncherName, text: string) =>
  [
    'mkdir -p "$HOME/.local/bin"',
    `cat > "$HOME/.local/bin/fleetx-${name}.tmp" <<'FLEETX_LAUNCHER'\n${text}FLEETX_LAUNCHER`,
    `chmod 755 "$HOME/.local/bin/fleetx-${name}.tmp" && mv -f "$HOME/.local/bin/fleetx-${name}.tmp" "$HOME/.local/bin/fleetx-${name}"`,
  ].join("\n");
