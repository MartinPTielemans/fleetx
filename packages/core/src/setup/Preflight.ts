/**
 * Before setup changes anything: does this machine have what T3 Fleet needs?
 *
 *   node     24 or newer
 *   git      to keep the config repo
 *   gh       optional: creates the fleet's private repository
 *   PATH     ~/.local/bin on it, where t3-fleet lives
 *   timer    a service manager that will run the sync timer: launchd, or
 *            systemd's user instance with lingering (or root's)
 *
 * `t3-fleet doctor` shows the same checks on a machine not set up yet.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { exec } from "../Exec.ts";
import { MIN_NODE_MAJOR } from "../Runtime.ts";

export interface Check {
  readonly key: string;
  /** error: setup cannot go on; warn: it can, with what the detail says. */
  readonly severity: "ok" | "info" | "warn" | "error";
  readonly title: string;
  readonly detail?: string;
}

export interface Preflight {
  readonly checks: ReadonlyArray<Check>;
  /** Whether a sync timer installed here would run; when not, why. */
  readonly timer: { readonly works: true } | { readonly works: false; readonly why: string };
  /** The GitHub account gh is signed in to; null without gh or a sign-in. */
  readonly github: string | null;
}

const run = (command: string, args: ReadonlyArray<string>, seconds = 10) =>
  exec({ command, args, timeout: Duration.seconds(seconds) });

/** Whether this machine has a service manager that keeps a timer running, and if not, why. */
const serviceManager = Effect.gen(function* () {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    const launchd = yield* run("launchctl", ["print", `gui/${uid}`], 5);
    return launchd.code === 0
      ? ({ works: true } as const)
      : ({
          works: false,
          why: "launchd has no session for this user (logged in over ssh only?)",
        } as const);
  }
  const root = process.getuid?.() === 0;
  const systemd = yield* run("systemctl", [...(root ? [] : ["--user"]), "show-environment"], 5);
  if (systemd.code !== 0)
    return {
      works: false,
      why:
        systemd.spawnError !== undefined
          ? "no systemd here (a container?); sync runs when you run it"
          : "systemd has no user instance for this user; sync runs when you run it",
    } as const;
  if (root) return { works: true } as const;
  const user = (yield* run("id", ["-un"], 5)).stdout.trim();
  const linger = (yield* run(
    "loginctl",
    ["show-user", user, "-p", "Linger", "--value"],
    5,
  )).stdout.trim();
  if (linger === "yes") return { works: true } as const;
  // The timer's install asks sudo for lingering itself, without a password prompt.
  const sudo = yield* run("sudo", ["-n", "true"], 5);
  return sudo.code === 0
    ? ({ works: true } as const)
    : ({
        works: false,
        why: `the timer would stop when you log out: run \`sudo loginctl enable-linger ${user}\`, then \`t3-fleet setup\` turns the timer on`,
      } as const);
});

export const preflight = Effect.gen(function* () {
  const home = process.env["HOME"] ?? "";
  const checks: Array<Check> = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= MIN_NODE_MAJOR
      ? { key: "node", severity: "ok", title: `Node ${process.versions.node}` }
      : {
          key: "node",
          severity: "error",
          title: `Node ${process.versions.node} is older than ${MIN_NODE_MAJOR}`,
          detail: "install Node 24 or newer (https://nodejs.org), then run setup again",
        },
  );
  const git = yield* run("git", ["--version"], 5);
  checks.push(
    git.code === 0
      ? { key: "git", severity: "ok", title: git.stdout.trim() }
      : {
          key: "git",
          severity: "error",
          title: "git is not installed",
          detail: "T3 Fleet keeps the fleet in a git repository; install git first",
        },
  );
  const gh = yield* run("gh", ["api", "user", "--jq", ".login"], 15);
  const github = gh.code === 0 && gh.stdout.trim() !== "" ? gh.stdout.trim() : null;
  checks.push(
    github !== null
      ? { key: "gh", severity: "ok", title: `gh signed in as ${github}` }
      : {
          key: "gh",
          severity: "info",
          title: gh.spawnError !== undefined ? "gh is not installed" : "gh is not signed in",
          detail:
            "optional: with gh signed in (gh auth login), setup creates the fleet's private repository on GitHub",
        },
  );
  const onPath = (process.env["PATH"] ?? "")
    .split(":")
    .map((d) => d.replace(/^~(?=\/)/, home).replace(/\/+$/, ""))
    .includes(`${home}/.local/bin`);
  checks.push(
    onPath
      ? { key: "path", severity: "ok", title: "~/.local/bin is on PATH" }
      : {
          key: "path",
          severity: "warn",
          title: "~/.local/bin is not on PATH",
          detail:
            'add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile: t3-fleet, and the agents\' MCP entry for it, live there',
        },
  );
  const timer = yield* serviceManager;
  checks.push(
    timer.works
      ? {
          key: "timer",
          severity: "ok",
          title: `${process.platform === "darwin" ? "launchd" : "systemd"} will run the sync timer`,
        }
      : {
          key: "timer",
          severity: "warn",
          title: "no sync timer on this machine",
          detail: timer.why,
        },
  );
  return { checks, timer, github } satisfies Preflight;
});
