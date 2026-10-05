/**
 * The hub's half of browser setup, run over the existing checks/fixes SSH transport.
 * No probe writes files, accepts a new host key, installs software, or starts a service.
 *
 * Authority handoff (two small additions to the wizard contract):
 *   input.bundle: the CLI bundle captured by the authority's ownBundle/liveController.
 *     Shipping that exact build, with Fix.installEngineScript, keeps both machines equal
 *     even before a release exists. The caller must reject a stale liveController first.
 *   result.recipient: the hub's public age key, never its private key or any secret.
 *     After joining, the authority approves the hub's proposal, adds this recipient,
 *     and syncs the hub so the approved relay configuration and token take effect.
 *
 * The authority owns [relay], its token, the hub's member/relay roles and MCP defaults.
 * It must publish those before this call when [relay] already exists: setup --relay
 * only offers a new relay when the fleet has none. relayUrl is the approved address;
 * this module does not override it or generate a second authority-side token.
 *
 * T3's CLI reports its version and installed service. It has no live descriptor
 * discovery command, so the descriptor probe reads only server-runtime.json's origin
 * (the same fallback as Probe.ts), then asks T3's own HTTP descriptor. An installed
 * service or a saved T3 Connect setting alone is never reported as a running server.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { parse as parseToml } from "smol-toml";

import { sh, shPath } from "../Area.ts";
import { parseVersion, type ExecResult } from "../Exec.ts";
import { installEngineScript } from "../Fix.ts";
import { BUNDLE_FILE, CONFIG_DIR, DEFAULT_RELAY_PORT, SHARE_DIR, STATE_DIR } from "../Names.ts";
import { remoteExec, validSshDestination } from "../Remote.ts";
import { MIN_NODE_MAJOR } from "../Runtime.ts";
import type { UiProbe, UiProbeItem } from "../SetupApi.ts";
import { cleanUrl } from "./Discover.ts";
import { Progress } from "./State.ts";

const environment =
  'export PATH="$HOME/.local/bin:$PATH"\nexport NO_COLOR=1\nunset T3_FLEET_CONFIG_REPO T3_FLEET_NODE\n';
const run = (ssh: string, script: string, seconds = 10) =>
  remoteExec(ssh, {
    command: "bash -l -s",
    stdin: `${environment}${script}\n`,
    timeout: Duration.seconds(seconds),
  });
const command = (name: string, args: string) =>
  `command -v ${name} >/dev/null 2>&1 || exit 127\n${name} ${args}`;
const item = (
  state: UiProbeItem["state"],
  label: string,
  remedy: string | null = null,
): UiProbeItem => ({ state, label, remedy });
const unknown = (name: string, remedy: string) =>
  item("unknown", `${name} could not be checked`, remedy);
const answered = (r: ExecResult) => !r.timedOut && r.spawnError === undefined && r.code !== 255;

const sshError = (ssh: string, r: ExecResult): string => {
  if (r.timedOut || /timed? out/i.test(r.stderr))
    return `No answer from ${ssh} in time. Check that it is on and reachable, then try again.`;
  if (/host key|REMOTE HOST IDENTIFICATION|authenticity/i.test(r.stderr))
    return `The SSH host key for ${ssh} is unknown or changed. Verify it with the server's owner, connect with ssh ${ssh} in a terminal, then try again.`;
  if (/permission denied|authentication|too many authentication/i.test(r.stderr))
    return `SSH could not sign in to ${ssh}. Set up an SSH key for this user and check ssh ${ssh} works without a password.`;
  if (/resolve hostname|name or service not known|nodename nor servname/i.test(r.stderr))
    return `This computer cannot find ${ssh}. Check the SSH host name or alias and your network connection.`;
  if (r.spawnError !== undefined)
    return `SSH could not start. Install the OpenSSH client on this computer and check the host name.`;
  return `SSH could not reach ${ssh}. Check its address, network, and SSH service with ssh ${ssh}, then try again.`;
};

const unavailable = (ssh: string, error: string): UiProbe => {
  const remedy = "Fix the SSH connection above, then check the hub again.";
  return {
    ssh,
    reachable: false,
    error,
    hostname: null,
    os: null,
    node: unknown("Node", remedy),
    git: unknown("Git", remedy),
    t3: unknown("T3", remedy),
    tailscale: unknown("Tailscale", remedy),
    docker: unknown("Docker", remedy),
    service: unknown("Service manager", remedy),
    relayUrl: null,
    ready: false,
  };
};

const Tailscale = Schema.Struct({
  BackendState: Schema.String,
  Self: Schema.optionalKey(Schema.Struct({ DNSName: Schema.optionalKey(Schema.String) })),
});
const Descriptor = Schema.Struct({
  running: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
});
const decodeTailscale = Schema.decodeEffect(Schema.fromJsonString(Tailscale));
const decodeDescriptor = Schema.decodeEffect(Schema.fromJsonString(Descriptor));

// Streamed into node -, just like the existing remote checks. Bounded even when HTTP stalls.
const descriptorScript = `
import { readFile } from "node:fs/promises";
let result = { running: false, version: null };
try {
  const runtime = JSON.parse(await readFile(process.env.HOME + "/.t3/server-runtime.json", "utf8"));
  const origin = new URL(runtime.origin);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("not local");
  const response = await fetch(new URL("/.well-known/t3/environment", origin), { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (response.ok) {
    const descriptor = await response.json();
    if (typeof descriptor.serverVersion === "string") result = { running: true, version: descriptor.serverVersion };
  }
} catch {}
process.stdout.write(JSON.stringify(result) + "\\n");
`;

const serviceProbe = (os: string) =>
  os === "Darwin"
    ? 'command -v launchctl >/dev/null 2>&1 || exit 127\nlaunchctl print "gui/$(id -u)" >/dev/null || exit 1\necho launchd'
    : os === "Linux"
      ? [
          "command -v systemctl >/dev/null 2>&1 || exit 127",
          'if [ "$(id -u)" = 0 ]; then systemctl show-environment >/dev/null || exit 1; echo systemd-root; exit 0; fi',
          "systemctl --user show-environment >/dev/null || exit 1",
          'linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null) || exit 3',
          '[ "$linger" = yes ] || exit 2',
          "echo systemd-user",
        ].join("\n")
      : "exit 127";

/** Read-only, including on a machine without Node. Every command has an SSH and process timeout. */
export const probeHub = (ssh: string) =>
  Effect.gen(function* () {
    if (!validSshDestination(ssh))
      return unavailable(ssh, "Enter an SSH host or user@host, without options or spaces.");
    const identity = yield* run(ssh, "hostname && uname -s", 15);
    if (!answered(identity) || identity.code !== 0)
      return unavailable(ssh, sshError(ssh, identity));
    const lines = identity.stdout.trim().split("\n");
    const os = lines.at(-1) ?? "";
    const hostname = lines.at(-2) ?? null;
    const [nodeRun, gitRun, t3Version, t3Service, tsRun, dockerRun, serviceRun] = yield* Effect.all(
      [
        run(ssh, command("node", "--version")),
        run(ssh, command("git", "--version")),
        run(ssh, command("t3", "--version")),
        run(ssh, command("t3", "service status")),
        run(
          ssh,
          'ts=tailscale\ncommand -v "$ts" >/dev/null 2>&1 || ts="${T3_FLEET_TAILSCALE_APP:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"\n[ -x "$ts" ] || command -v "$ts" >/dev/null 2>&1 || exit 127\n"$ts" status --json',
        ),
        run(ssh, command("docker", "version --format '{{.Server.Version}}'")),
        run(ssh, serviceProbe(os)),
      ],
      { concurrency: 4 },
    );
    const version = nodeRun.code === 0 ? parseVersion(nodeRun.stdout) : undefined;
    const node = !answered(nodeRun)
      ? unknown("Node", "Check node --version on the hub, then try again.")
      : version === undefined
        ? item(
            nodeRun.code === 127 ? "missing" : "unknown",
            "Node is not available",
            "Install Node 24 or newer from https://nodejs.org and make node available in an SSH login shell.",
          )
        : Number(version.split(".")[0]) < MIN_NODE_MAJOR
          ? item(
              "warn",
              `Node ${version} is older than ${MIN_NODE_MAJOR}`,
              "Upgrade to Node 24 or newer, then check the hub again.",
            )
          : item("ok", `Node ${version}`);
    const git = !answered(gitRun)
      ? unknown("Git", "Check git --version on the hub, then try again.")
      : gitRun.code === 0
        ? item("ok", gitRun.stdout.trim())
        : item(
            gitRun.code === 127 ? "missing" : "warn",
            "Git is not available",
            os === "Darwin"
              ? "Install git with brew install git, then check the hub again."
              : "Install git with your package manager, for example sudo apt-get install git, then check the hub again.",
          );
    const live =
      node.state === "ok"
        ? yield* remoteExec(ssh, {
            command: "bash -lc 'node --input-type=module -'",
            stdin: descriptorScript,
            timeout: Duration.seconds(10),
          })
        : null;
    const descriptor =
      live?.code === 0
        ? yield* decodeDescriptor(live.stdout.trim()).pipe(Effect.option)
        : Option.none();
    const installedVersion = t3Version.code === 0 ? parseVersion(t3Version.stdout) : undefined;
    const t3 =
      Option.isSome(descriptor) && descriptor.value.running
        ? item("ok", `T3 ${descriptor.value.version ?? installedVersion ?? ""} is running`)
        : t3Version.code === 127 && t3Service.code === 127 && Option.isSome(descriptor)
          ? item(
              "missing",
              "T3 is not installed or running",
              "Optional: install T3 Code on the hub, then run t3 service install. The relay works without T3.",
            )
          : installedVersion !== undefined && Option.isSome(descriptor)
            ? item(
                "warn",
                `T3 ${installedVersion} is installed but not running`,
                /Status: installed/.test(t3Service.stdout)
                  ? "Run t3 service restart on the hub, then check it again."
                  : "Run t3 service install on the hub, then check it again.",
              )
            : unknown(
                "T3's running server",
                "Check t3 --version and t3 service status on the hub. Check that its local T3 HTTP descriptor answers; T3 is optional for a relay.",
              );
    const ts =
      tsRun.code === 0
        ? yield* decodeTailscale(tsRun.stdout.trim()).pipe(Effect.option)
        : Option.none();
    const dns =
      Option.isSome(ts) && ts.value.BackendState === "Running"
        ? ts.value.Self?.DNSName?.replace(/\.$/, "")
        : undefined;
    const relayUrl =
      dns && /^[a-z0-9][a-z0-9.-]*$/i.test(dns) ? `https://${dns}:${DEFAULT_RELAY_PORT}` : null;
    const tailscale =
      tsRun.code === 127
        ? item(
            "missing",
            "Tailscale is not installed",
            "Recommended: install Tailscale from https://tailscale.com/download, sign in on the hub, and enable MagicDNS.",
          )
        : !answered(tsRun) || (tsRun.code === 0 && Option.isNone(ts))
          ? unknown("Tailscale", "Run tailscale status --json on the hub, then check it again.")
          : relayUrl !== null
            ? item("ok", `Tailscale: ${dns}`)
            : item(
                "warn",
                Option.isSome(ts) && ts.value.BackendState === "Running"
                  ? "Tailscale is running without a MagicDNS name"
                  : "Tailscale is not running or signed in",
                "Start Tailscale and sign in with tailscale up on the hub; enable MagicDNS in the tailnet's DNS settings, then check again. You can also set a reachable relay URL later.",
              );
    const docker =
      dockerRun.code === 127
        ? item(
            "missing",
            "Docker is not installed",
            "Recommended: install Docker from https://docs.docker.com/engine/install so the MCP hub can run container servers.",
          )
        : !answered(dockerRun)
          ? unknown("Docker", "Check docker version on the hub as the SSH user, then try again.")
          : dockerRun.code === 0 && dockerRun.stdout.trim() !== ""
            ? item("ok", `Docker ${dockerRun.stdout.trim()}; daemon is reachable`)
            : item(
                "warn",
                "Docker is installed but its daemon is not reachable by this user",
                "Start Docker and give the SSH user access to its daemon, then check docker version as that user. Remote MCP servers can work without Docker.",
              );
    const service = !answered(serviceRun)
      ? unknown(
          "Service manager",
          "Check launchctl print gui/$(id -u) on macOS, or systemctl --user show-environment on Linux, then try again.",
        )
      : serviceRun.code === 0
        ? item(
            "ok",
            os === "Darwin"
              ? "launchd has a session for this user"
              : serviceRun.stdout.trim() === "systemd-root"
                ? "systemd system services are available for root"
                : "systemd user services are available with linger enabled",
          )
        : serviceRun.code === 2
          ? item(
              "warn",
              "systemd user services stop at logout",
              "Run sudo loginctl enable-linger $(id -un) on the hub, then check it again.",
            )
          : serviceRun.code === 3
            ? unknown(
                "systemd linger",
                "Check loginctl show-user $(id -un) -p Linger --value; enable it with sudo loginctl enable-linger $(id -un), then check again.",
              )
            : item(
                serviceRun.code === 127 ? "missing" : "warn",
                os === "Darwin"
                  ? "launchd has no session for this user"
                  : "systemd services are not available",
                os === "Darwin"
                  ? "Log in to the hub's macOS desktop as the SSH user so launchd has a GUI session, then check again."
                  : "Use a Linux host with systemd. Ensure systemctl --user show-environment works for the SSH user and enable linger with sudo loginctl enable-linger $(id -un).",
              );
    return {
      ssh,
      reachable: true,
      error: null,
      hostname,
      os,
      node,
      git,
      t3,
      tailscale,
      docker,
      service,
      relayUrl,
      ready: [node, git, service].every((i) => i.state === "ok"),
    } satisfies UiProbe;
  });

/** The hub half only. Approval, secrets access and the relay's first sync belong to the authority. */
export const hubPlanSteps = (probe: UiProbe): ReadonlyArray<string> => [
  `Install this computer's T3 Fleet build on ${probe.hostname ?? probe.ssh}`,
  "Join the fleet as a member and relay, or resume its unfinished setup",
  "Create or read the hub's public key for the authority to grant secrets access",
];

const LocalConfig = Schema.Struct({ repo: Schema.String, node: Schema.String });
const decodeLocalConfig = Schema.decodeUnknownEffect(LocalConfig);
const localConfigScript = `if [ -f "$HOME/${CONFIG_DIR}/config.toml" ]; then cat "$HOME/${CONFIG_DIR}/config.toml"; fi`;

const decodeProgress = Schema.decodeEffect(Schema.fromJsonString(Schema.NullOr(Progress)));
const progressScript = `if [ -f "$HOME/${STATE_DIR}/setup.json" ]; then cat "$HOME/${STATE_DIR}/setup.json"; else echo null; fi`;
const checked = (ssh: string, script: string, what: string, seconds = 30) =>
  Effect.gen(function* () {
    const result = yield* run(ssh, `set -e\n${script}`, seconds);
    if (!answered(result)) return yield* Effect.fail(sshError(ssh, result));
    if (result.code !== 0) {
      const detail = (result.stdout + "\n" + result.stderr)
        .trim()
        .split("\n")
        .filter((s) => s.trim() !== "")
        .slice(-8)
        .join("\n");
      return yield* Effect.fail(
        `${what} failed on ${ssh}${detail ? `: ${detail.replace(/([a-z+]+:\/\/)[^\s/@]+@/gi, "$1").replace(/AGE-SECRET-KEY-[A-Z0-9-]+/g, "[private key removed]")}` : "."} Fix the reported problem on the hub and retry the wizard; unfinished setup will resume.`,
      );
    }
    return result.stdout;
  });

/** Mutating: call only after hubPlanSteps has been shown and the user starts apply. */
export const bringUpHub = (input: {
  readonly ssh: string;
  readonly node: string;
  readonly repoUrl: string;
  readonly relayUrl: string | null;
  readonly bundle: string;
  readonly onStep: (step: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    if (!validSshDestination(input.ssh))
      return yield* Effect.fail("Enter an SSH host or user@host, without options or spaces.");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.node))
      return yield* Effect.fail(
        "Choose a node name with lowercase letters, numbers and hyphens, starting with a letter or number.",
      );
    if (
      input.repoUrl === "" ||
      input.repoUrl.startsWith("-") ||
      Array.from(input.repoUrl).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return yield* Effect.fail("Give the fleet's repository URL, then try again.");
    if (input.bundle.trim() === "")
      return yield* Effect.fail(
        "This computer has no T3 Fleet build to send. Build or reinstall T3 Fleet and restart the wizard.",
      );
    if (input.relayUrl !== null && !/^https?:\/\/[^\s]+$/.test(input.relayUrl))
      return yield* Effect.fail(
        "Give an http or https relay URL, or leave it unset until the hub is reachable.",
      );
    yield* input.onStep(`Checking for an unfinished setup on ${input.ssh}`);
    const saved = yield* decodeProgress(
      yield* checked(input.ssh, progressScript, "Reading setup progress"),
    ).pipe(
      Effect.mapError(
        () =>
          "The hub's saved setup is unreadable. Inspect ~/.local/state/t3-fleet/setup.json on the hub before trying again; do not overwrite an unfinished run.",
      ),
    );
    if (
      saved !== null &&
      (saved.mode === "first" ||
        saved.node !== input.node ||
        (saved.url !== null && cleanUrl(saved.url) !== cleanUrl(input.repoUrl)))
    )
      return yield* Effect.fail(
        "The hub already has a setup for another node or repository. Finish it with t3-fleet setup --resume there, or deliberately abandon it with t3-fleet setup --abandon, before setting up this hub.",
      );
    // setup with an existing local membership ignores positional repo/name. Refuse a different
    // fleet before installing anything, including when its old progress file has been removed.
    const local = yield* checked(
      input.ssh,
      localConfigScript,
      "Reading the hub's fleet membership",
    );
    if (local.trim() !== "") {
      const config = yield* Effect.try({
        try: () => parseToml(local),
        catch: () =>
          "The hub's fleet config is unreadable. Repair ~/.config/t3-fleet/config.toml on the hub, then try again.",
      }).pipe(
        Effect.flatMap(decodeLocalConfig),
        Effect.mapError(
          () =>
            "The hub's fleet config is unreadable. Repair ~/.config/t3-fleet/config.toml on the hub, then try again.",
        ),
      );
      if (config.node !== input.node)
        return yield* Effect.fail(
          "The hub belongs to another node. Check ~/.config/t3-fleet/config.toml on the hub before trying again.",
        );
      const origin = yield* checked(
        input.ssh,
        `git -C ${shPath(config.repo)} remote get-url origin`,
        "Checking the hub's repository",
      );
      if (cleanUrl(origin.trim()) !== cleanUrl(input.repoUrl))
        return yield* Effect.fail(
          "The hub belongs to another repository. Check its fleet checkout and origin remote before trying again.",
        );
    }
    yield* input.onStep(`Installing T3 Fleet on ${input.ssh}`);
    yield* checked(input.ssh, installEngineScript(input.bundle), "Installing T3 Fleet", 120);
    const cli = `node "$HOME/${SHARE_DIR}/${BUNDLE_FILE}"`;
    const resume = saved !== null && saved.finishedAt === null;
    if (saved?.finishedAt != null) {
      yield* input.onStep("The hub has already joined the fleet");
    } else {
      yield* input.onStep(resume ? "Resuming the hub's unfinished setup" : "Joining the fleet");
      yield* checked(
        input.ssh,
        `${cli} setup ${sh(input.repoUrl)} ${sh(input.node)} --relay --yes${resume ? " --resume" : ""}`,
        "Joining the fleet",
        600,
      );
    }
    yield* input.onStep("Reading the hub's public key");
    const key = yield* checked(input.ssh, `${cli} secrets init`, "Reading the hub's public key");
    const recipient = /\bpublic: (age1[0-9a-z]+)\b/.exec(key)?.[1];
    if (recipient === undefined)
      return yield* Effect.fail(
        "The hub did not return its public key. Run t3-fleet secrets init there and retry the wizard; no private key is needed.",
      );
    return { recipient };
  });
