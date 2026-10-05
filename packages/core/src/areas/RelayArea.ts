/**
 * The relay's long-running pieces, when the fleet has a relay ([relay] in
 * the fleet's settings):
 *
 *   on the node with the relay role   `t3-fleet relay serve` as a service, its
 *                                     port published to the tailnet only
 *   on every other node               `t3-fleet listen` as a service, so it
 *                                     syncs as soon as the branch moves
 *
 * Services run the absolute node binary and bundle with a fixed PATH, like
 * the sync timer, and restart when they exit. Before offering one it checks
 * what the service needs, since a service missing it would only restart
 * forever: the relay token in the node's secrets, and on the relay node
 * Tailscale (when nodes reach it on the tailnet) and Docker (when the hub
 * runs container or registry servers).
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineArea, sh } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { DEFAULT_RELAY_PORT, launchdLabel, STATE_DIR, systemdUnit } from "../Names.ts";
import { RELAY_TOKEN } from "../RelayClient.ts";
import { installedBundle, launchdReload, stableNode } from "../Runtime.ts";
import { localSecretsPath } from "../Secrets.ts";

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
  /** Whether the node's secrets hold the relay token. Absent in reports from before it was observed. */
  token: Schema.optionalKey(Schema.Boolean),
  /** Relay node reached on the tailnet: whether the tailscale CLI is there; null when not needed. */
  tailscale: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** How to run it: `tailscale`, or the macOS app's own CLI when that is all there is. */
  tailscaleCommand: Schema.optionalKey(Schema.String),
  /** Relay node: the hub's servers that run in Docker, and whether docker is there. */
  containers: Schema.optionalKey(Schema.Array(Schema.String)),
  docker: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

/** The domain Tailscale's MagicDNS names end in. */
const TAILNET_DOMAIN = "ts.net";

/**
 * Whether `url` names a host on a tailnet: a MagicDNS name (`box`,
 * `server.tailnet.ts.net`) or a Tailscale address (100.64.0.0/10). No URL: the
 * relay is published on the tailnet, as the service does by default.
 */
export const onTailnet = (url: string | null) => {
  if (url === null) return true;
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(url)?.[1]?.toLowerCase() ?? "";
  if (host === TAILNET_DOMAIN || host.endsWith(`.${TAILNET_DOMAIN}`)) return true;
  const ip = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  if (ip !== null) return Number(ip[1]) >= 64 && Number(ip[1]) < 128;
  return host !== "" && host !== "localhost" && !host.includes(".") && !host.includes("[");
};

/** The hub's servers of a kind that runs in Docker, from the repo's mcp/*.json. */
const containerServers = (repo: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(`${repo}/mcp`)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const names: Array<string> = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const kind = yield* fs.readFileString(`${repo}/mcp/${file}`).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(KindOnly))),
        Effect.map((d) => d.kind ?? null),
        Effect.orElseSucceed(() => null),
      );
      if (kind === "container" || kind === "registry") names.push(file.slice(0, -".json".length));
    }
    return names;
  });
const KindOnly = Schema.Struct({ kind: Schema.optionalKey(Schema.String) });

/** Whether the node's installed secrets, or its environment, hold `name`. */
const hasSecret = (home: string, env: Readonly<Record<string, string | undefined>>, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(localSecretsPath(home))
      .pipe(Effect.orElseSucceed(() => ""));
    const line = new RegExp(`^\\s*(?:export\\s+)?${name}=["']?([^"'\\s]+)`, "m");
    return line.test(text) || (env[name] ?? "") !== "";
  });

/**
 * The Tailscale CLI: on PATH, or inside the macOS app, which installs none on
 * PATH by default. T3_FLEET_TAILSCALE_APP names another app CLI to look for.
 */
export const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const findTailscale = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    if (yield* onPath("tailscale", env)) return "tailscale";
    const fs = yield* FileSystem.FileSystem;
    const app = env["T3_FLEET_TAILSCALE_APP"] ?? TAILSCALE_APP;
    return (yield* fs.exists(app).pipe(Effect.orElseSucceed(() => false))) ? app : null;
  });

/** Whether `command` is on the node's PATH. */
const onPath = (command: string, env: Readonly<Record<string, string | undefined>>) =>
  exec({
    command: "sh",
    args: ["-c", `command -v ${command}`],
    env,
    timeout: Duration.seconds(5),
  }).pipe(Effect.map((r) => r.code === 0));

const label = launchdLabel;
const unitName = systemdUnit;

const unitPath = (platform: string, root: boolean, home: string, role: string) =>
  platform === "darwin"
    ? `${home}/Library/LaunchAgents/${label(role)}.plist`
    : root
      ? `/etc/systemd/system/${unitName(role)}.service`
      : `${home}/.config/systemd/user/${unitName(role)}.service`;

const unitText = (
  platform: string,
  root: boolean,
  home: string,
  nodePath: string,
  bundle: string,
  role: "serve" | "listen",
) => {
  const args = role === "serve" ? ["relay", "serve"] : ["listen"];
  const path = `${home}/.local/bin:${platform === "darwin" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`;
  const log = `${home}/${STATE_DIR}/${role}.log`;
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
Description=T3 Fleet ${role === "serve" ? "relay" : "listener"}
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
  const write = (file: string) => `cat > ${file} <<'T3_FLEET_UNIT'\n${text}T3_FLEET_UNIT`;
  if (platform === "darwin") {
    const plist = `"$HOME/Library/LaunchAgents/${label(role)}.plist"`;
    return [
      `mkdir -p "$HOME/Library/LaunchAgents" "$HOME/${STATE_DIR}"`,
      write(plist),
      launchdReload(label(role), plist),
    ].join("\n");
  }
  const dir = root ? "/etc/systemd/system" : '"$HOME/.config/systemd/user"';
  const ctl = root ? "systemctl" : "systemctl --user";
  return [
    `mkdir -p ${dir} "$HOME/${STATE_DIR}"`,
    write(`${dir}/${unitName(role)}.service`),
    ...(root
      ? []
      : [
          '[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ] || sudo -n loginctl enable-linger "$(id -un)"',
        ]),
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
      const port = ctx.relay?.port ?? DEFAULT_RELAY_PORT;
      const role =
        ctx.relay === null
          ? null
          : ctx.roles.includes("relay")
            ? ("serve" as const)
            : ctx.relay.url === null
              ? null
              : ("listen" as const);
      if (role === null)
        return {
          role,
          platform,
          root,
          installed: null,
          want: null,
          running: false,
          published: null,
          port,
        };
      const installed = Option.getOrNull(
        yield* fs.readFileString(unitPath(platform, root, ctx.home, role)).pipe(Effect.option),
      );
      const want = unitText(
        platform,
        root,
        ctx.home,
        yield* stableNode(ctx.home),
        yield* installedBundle(ctx.home),
        role,
      );
      const check =
        platform === "darwin"
          ? yield* exec({
              command: "launchctl",
              args: ["print", `gui/${process.getuid?.() ?? 0}/${label(role)}`],
              timeout: Duration.seconds(5),
            })
          : yield* exec({
              command: "systemctl",
              args: [
                ...(root ? [] : ["--user"]),
                "is-active",
                "--quiet",
                `${unitName(role)}.service`,
              ],
              timeout: Duration.seconds(5),
            });
      const running =
        platform === "darwin"
          ? check.code === 0 && /state = running/.test(check.stdout)
          : check.code === 0;
      const token = yield* hasSecret(ctx.home, ctx.env, RELAY_TOKEN);
      const tailnet = role === "serve" && onTailnet(ctx.relay?.url ?? null);
      const tailscaleCommand = tailnet ? yield* findTailscale(ctx.env) : null;
      const tailscale = tailnet ? tailscaleCommand !== null : null;
      const containers = role === "serve" ? yield* containerServers(ctx.checkout) : [];
      const docker = containers.length > 0 ? yield* onPath("docker", ctx.env) : null;
      let published: boolean | null = null;
      if (tailnet && tailscale === true) {
        const serve = yield* exec({
          command: tailscaleCommand ?? "tailscale",
          args: ["serve", "status"],
          env: ctx.env,
          timeout: Duration.seconds(10),
        });
        published =
          serve.code === 0 &&
          serve.stdout.includes(`:${port}`) &&
          serve.stdout.includes(`127.0.0.1:${port}`);
      }
      return {
        role,
        platform,
        root,
        installed,
        want,
        running,
        published,
        port,
        token,
        tailscale,
        ...(tailscaleCommand === null ? {} : { tailscaleCommand }),
        containers,
        docker,
      };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (observed.role === null || observed.want === null) return out;
    const what = observed.role === "serve" ? "relay" : "relay listener";
    // Without its token the service exits at once and restarts forever: no service until it has one.
    if (observed.token === false) {
      out.push({
        node,
        key: "relay-token-missing",
        severity: "error",
        area: "relay",
        title: `the ${what} cannot start: ${RELAY_TOKEN} is not in this machine's secrets`,
        detail: `On an authority, if the fleet has no relay token yet: t3-fleet secrets set ${RELAY_TOKEN}="$(openssl rand -hex 32)". Then t3-fleet sync here. If it has one, this machine cannot read the fleet's secrets yet; the secrets findings say why.`,
      });
    }
    if (observed.tailscale === false) {
      out.push({
        node,
        key: "relay-tailscale-missing",
        severity: "error",
        area: "relay",
        title:
          "Tailscale is not installed here, and the other machines reach the relay on the tailnet",
        detail:
          "Install Tailscale (https://tailscale.com/download) and run `tailscale up`; then the relay's port can be published to the tailnet.",
      });
    }
    if (observed.docker === false) {
      const names = observed.containers ?? [];
      out.push({
        node,
        key: "relay-docker-missing",
        severity: "error",
        area: "relay",
        title: `Docker is not installed here, and the hub runs ${names.join(", ")} in ${names.length === 1 ? "a container" : "containers"}`,
        detail:
          "Install Docker (https://docs.docker.com/engine/install/) and let this user run it; until then those servers do not answer.",
      });
    }
    if (observed.token !== false && (observed.installed !== observed.want || !observed.running)) {
      out.push({
        node,
        key: `relay-${observed.role}`,
        severity: "warn",
        area: "relay",
        title:
          observed.installed === null
            ? `the ${what} is not installed`
            : observed.installed !== observed.want
              ? `the ${what} is out of date`
              : `the ${what} is not running`,
        fix: {
          command: install(observed.platform, observed.root, observed.role, observed.want),
          safe: true,
        },
      });
    }
    if (observed.role === "serve" && observed.published === false && observed.tailscale !== false) {
      out.push({
        node,
        key: "relay-unpublished",
        severity: "warn",
        area: "relay",
        title: `the relay's port ${observed.port} is not published to the tailnet`,
        fix: {
          command: `${sh(observed.tailscaleCommand ?? "tailscale")} serve --bg --https=${observed.port} http://127.0.0.1:${observed.port}`,
          safe: true,
        },
      });
    }
    return out;
  },
});
