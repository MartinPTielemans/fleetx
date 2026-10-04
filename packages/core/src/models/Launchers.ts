/**
 * What the models area installs on a node: the proxy service, and one
 * launcher per routed T3 provider instance (~/.local/bin/t3-fleet-claude,
 * t3-fleet-codex, t3-fleet-<instance>). T3 points the instance at its launcher
 * instead of the CLI; the launcher runs the CLI pointed at the proxy, the way
 * the instance's recipe says (see Recipes.ts).
 *
 * A launcher must never be the reason a provider fails. When the proxy is not
 * listening it runs the CLI directly and writes a line to
 * ~/.local/state/t3-fleet/models-fallback.log, which the proxy's stats and the
 * area report. First arguments that make no model call (version, login,
 * auth) skip the proxy, so T3's own checks and the probe's fallback login
 * checks neither need it nor count as fallbacks.
 *
 * With a token_env, the launcher loads that credential from
 * ~/.config/t3-fleet/secrets.env when the environment has none.
 */
import { launchdLabel, SH_CONFIG_DIR, SH_STATE_DIR, STATE_DIR, systemdUnit } from "../Names.ts";
import { retireLegacyUnit } from "../Runtime.ts";
import { MODELS_PORT, proxyUrl, type Recipe } from "./Recipes.ts";

/** A double-quoted shell word, with {proxy} becoming the launcher's $proxy. */
const word = (value: string) => `"${value.replace(/[\\"$`]/g, "\\$&").replaceAll("{proxy}", "$proxy")}"`;

const cliWord = (command: string) => (command.startsWith("~/") ? `"$HOME/${command.slice(2).replace(/[\\"$`]/g, "\\$&")}"` : word(command));

export const launcherText = (instanceId: string, recipe: Recipe) => {
  const lines = [
    "#!/bin/sh",
    `# T3's ${instanceId} through the T3 Fleet model proxy (upstream ${recipe.upstream}), or directly when the`,
    "# proxy is not listening. Written by T3 Fleet's models area; edits are replaced.",
    `cli=${cliWord(recipe.command)}`,
    `proxy="${proxyUrl(recipe.upstream)}"`,
  ];
  if (recipe.tokenEnv !== null) {
    const t = recipe.tokenEnv;
    lines.push(
      `secrets="${SH_CONFIG_DIR}/secrets.env"`,
      `if [ -z "\${${t}:-}" ] && [ -f "$secrets" ]; then`,
      `  token=$(sed -n 's/^[[:space:]]*\\(export[[:space:]][[:space:]]*\\)\\{0,1\\}${t}=//p' "$secrets" | tail -n 1)`,
      '  token=${token#\\"}; token=${token%\\"}',
      `  if [ -n "$token" ]; then export ${t}="$token"; fi`,
      "fi",
    );
  }
  if (recipe.direct.length > 0) {
    lines.push('case "${1:-}" in', `  ${recipe.direct.join("|")}) exec "$cli" "$@" ;;`, "esac");
  }
  lines.push(
    `listening() { command -v curl >/dev/null 2>&1 && curl -fsS -m 1 "http://127.0.0.1:${MODELS_PORT}/health" >/dev/null 2>&1; }`,
    "if listening; then",
    ...Object.entries(recipe.env).map(([k, v]) => `  export ${k}=${word(v)}`),
    `  exec "$cli"${recipe.args.map((a) => ` ${word(a)}`).join("")} "$@"`,
    "fi",
    `state="${SH_STATE_DIR}"`,
    'log="$state/models-fallback.log"',
    'mkdir -p "$state" 2>/dev/null',
    'if [ -f "$log" ] && [ "$(wc -c < "$log")" -gt 65536 ]; then mv -f "$log" "$log.1"; fi',
    `printf '%s\\t${recipe.upstream}\\t%s\\n' "$(date +%s)" "proxy not listening" >> "$log" 2>/dev/null`,
    'exec "$cli" "$@"',
    "",
  );
  return lines.join("\n");
};

// ---- the service -----------------------------------------------------------

export const SERVICE_LABEL = launchdLabel("models");
export const SERVICE_UNIT = systemdUnit("models");

export const serviceUnitPath = (platform: string, root: boolean, home: string) =>
  platform === "darwin"
    ? `${home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`
    : root
      ? `/etc/systemd/system/${SERVICE_UNIT}.service`
      : `${home}/.config/systemd/user/${SERVICE_UNIT}.service`;

/**
 * `t3-fleet models serve` with the absolute node and bundle and a fixed PATH,
 * restarted when it exits (like the relay's units). Egress is an argument, so
 * changing it makes the unit stale and its fix restarts the proxy.
 */
export const serviceUnitText = (platform: string, root: boolean, home: string, nodePath: string, bundle: string, egress: "direct" | "relay" = "direct") => {
  const args = ["models", "serve", ...(egress === "relay" ? ["--egress", "relay"] : [])];
  const path = `${home}/.local/bin:${platform === "darwin" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`;
  const log = `${home}/${STATE_DIR}/models.log`;
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
Description=T3 Fleet model proxy
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
  const write = (file: string) => `cat > ${file} <<'T3_FLEET_UNIT'\n${text}T3_FLEET_UNIT`;
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"`;
    return [
      retireLegacyUnit(platform, root, "models"),
      `mkdir -p "$HOME/Library/LaunchAgents" "$HOME/${STATE_DIR}"`,
      write(plist),
      `launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" 2>/dev/null; launchctl bootstrap "gui/$(id -u)" ${plist}`,
    ].join("\n");
  }
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    retireLegacyUnit(platform, root, "models"),
    `mkdir -p ${dir} "$HOME/${STATE_DIR}"`,
    write(`${dir}/${SERVICE_UNIT}.service`),
    ...(root ? [] : ['[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"']),
    `${ctl} daemon-reload && ${ctl} enable ${SERVICE_UNIT}.service && ${ctl} restart ${SERVICE_UNIT}.service`,
  ].join("\n");
};

/** Shell that writes a launcher, executable; `file` is its name in ~/.local/bin. */
export const launcherInstall = (file: string, text: string) =>
  [
    'mkdir -p "$HOME/.local/bin"',
    `cat > "$HOME/.local/bin/${file}.tmp" <<'T3_FLEET_LAUNCHER'\n${text}T3_FLEET_LAUNCHER`,
    `chmod 755 "$HOME/.local/bin/${file}.tmp" && mv -f "$HOME/.local/bin/${file}.tmp" "$HOME/.local/bin/${file}"`,
  ].join("\n");
