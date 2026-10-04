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
 * area report. It asks the proxy's /health with curl, or wget, or bash's
 * /dev/tcp, whichever the machine has. A CLI recipe under ~/ (Claude's
 * ~/.local/bin/claude) that is not there is looked up on PATH instead. First arguments that make no model call (version, login,
 * auth) skip the proxy, so T3's own checks and the probe's fallback login
 * checks neither need it nor count as fallbacks.
 *
 * With a token_env, the launcher loads that credential from
 * ~/.config/t3-fleet/secrets.env when the environment has none.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { launchdLabel, SH_CONFIG_DIR, SH_STATE_DIR, STATE_DIR, systemdUnit } from "../Names.ts";
import { launchdReload } from "../Runtime.ts";
import { MODELS_PORT, proxyUrl, type Recipe } from "./Recipes.ts";

/** A double-quoted shell word, with {proxy} becoming the launcher's $proxy. */
const word = (value: string) =>
  `"${value.replace(/[\\"$`]/g, "\\$&").replaceAll("{proxy}", "$proxy")}"`;

const cliWord = (command: string) =>
  command.startsWith("~/")
    ? `"$HOME/${command.slice(2).replace(/[\\"$`]/g, "\\$&")}"`
    : word(command);

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `port` is for tests; the proxy is always on MODELS_PORT. */
export const launcherText = (instanceId: string, recipe: Recipe, port: number = MODELS_PORT) => {
  const lines = [
    "#!/bin/sh",
    `# T3's ${instanceId} through the T3 Fleet model proxy (upstream ${recipe.upstream}), or directly when the`,
    "# proxy is not listening. Written by T3 Fleet's models area; edits are replaced.",
    `cli=${cliWord(recipe.command)}`,
    ...(recipe.command.startsWith("~/")
      ? [`[ -x "$cli" ] || cli=${word(basename(recipe.command))}`]
      : []),
    `proxy="${proxyUrl(recipe.upstream, port)}"`,
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
  const health = `http://127.0.0.1:${port}/health`;
  const tcp = `exec 3<>/dev/tcp/127.0.0.1/${port} && printf "GET /health HTTP/1.0\\r\\nHost: 127.0.0.1:${port}\\r\\n\\r\\n" >&3 && read -r -t 1 status <&3 && case $status in *" 200 "*) ;; *) exit 1 ;; esac`;
  lines.push(
    "listening() {",
    `  if command -v curl >/dev/null 2>&1; then curl -fsS -m 1 "${health}" >/dev/null 2>&1`,
    `  elif command -v wget >/dev/null 2>&1; then wget -q -T 1 -O /dev/null "${health}" >/dev/null 2>&1`,
    `  elif command -v bash >/dev/null 2>&1; then bash -c '${tcp}' >/dev/null 2>&1`,
    "  else return 1; fi",
    "}",
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

/**
 * How long the proxy keeps answering after SIGTERM, for the responses in
 * flight to finish; the units give it a little longer before they kill it.
 */
export const STOP_DRAIN_SECONDS = 45;
const STOP_TIMEOUT_SECONDS = 75;

export const serviceUnitPath = (platform: string, root: boolean, home: string) =>
  platform === "darwin"
    ? `${home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`
    : root
      ? `/etc/systemd/system/${SERVICE_UNIT}.service`
      : `${home}/.config/systemd/user/${SERVICE_UNIT}.service`;

/**
 * `t3-fleet models serve` with the absolute node and bundle and a fixed PATH,
 * restarted a second after it exits, with no limit on restarts: it exits by
 * itself once a new build is installed and its requests are done, and the
 * CLIs retry a refused connection for about that long. A stop waits for the requests in flight
 * (STOP_DRAIN_SECONDS). Egress is an argument, so changing it makes the unit
 * stale and its fix restarts the proxy.
 */
export const serviceUnitText = (
  platform: string,
  root: boolean,
  home: string,
  nodePath: string,
  bundle: string,
  egress: "direct" | "relay" = "direct",
) => {
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
  <key>ThrottleInterval</key><integer>1</integer>
  <key>ExitTimeOut</key><integer>${STOP_TIMEOUT_SECONDS}</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
  }
  return `[Unit]
Description=T3 Fleet model proxy
After=network-online.target
Wants=network-online.target
# Restarted a second after any exit, so the default limit (5 starts in 10s) would leave
# it failed for good after a few quick failures (the port still held, node mid-upgrade).
StartLimitIntervalSec=0

[Service]
Environment=HOME=${home}
Environment=PATH=${path}
Environment=NO_COLOR=1
ExecStart=${nodePath} ${bundle} ${args.join(" ")}
Restart=always
RestartSec=1
TimeoutStopSec=${STOP_TIMEOUT_SECONDS}
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
      `mkdir -p "$HOME/Library/LaunchAgents" "$HOME/${STATE_DIR}"`,
      write(plist),
      // The proxy being replaced may drain for up to its ExitTimeOut before it is gone.
      launchdReload(SERVICE_LABEL, plist, STOP_TIMEOUT_SECONDS),
    ].join("\n");
  }
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    `mkdir -p ${dir} "$HOME/${STATE_DIR}"`,
    write(`${dir}/${SERVICE_UNIT}.service`),
    ...(root
      ? []
      : [
          '[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"',
        ]),
    `${ctl} daemon-reload && ${ctl} enable ${SERVICE_UNIT}.service && ${ctl} restart ${SERVICE_UNIT}.service`,
  ].join("\n");
};

/**
 * The CLI a launcher will run: a recipe's ~/ path when it is there, else that
 * name found on PATH (or in ~/.local/bin); null when neither exists.
 */
export const findCli = (home: string, command: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
    if (command.startsWith("~/") && (yield* exists(`${home}/${command.slice(2)}`)))
      return `${home}/${command.slice(2)}`;
    const name = basename(command);
    if (command.includes("/") && !command.startsWith("~/"))
      return (yield* exists(command)) ? command : null;
    for (const dir of [...path.split(":").filter((d) => d !== ""), `${home}/.local/bin`]) {
      if (yield* exists(`${dir}/${name}`)) return `${dir}/${name}`;
    }
    return null;
  });

/** Shell that writes a launcher, executable; `file` is its name in ~/.local/bin. */
export const launcherInstall = (file: string, text: string) =>
  [
    'mkdir -p "$HOME/.local/bin"',
    `cat > "$HOME/.local/bin/${file}.tmp" <<'T3_FLEET_LAUNCHER'\n${text}T3_FLEET_LAUNCHER`,
    `chmod 755 "$HOME/.local/bin/${file}.tmp" && mv -f "$HOME/.local/bin/${file}.tmp" "$HOME/.local/bin/${file}"`,
  ].join("\n");
