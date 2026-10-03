/**
 * The environment fleetx and T3 run in, as opposed to what they manage. Every
 * check here is a failure that has happened: a git config rewriting GitHub
 * HTTPS to SSH (which a timer cannot authenticate), a T3 server whose PATH
 * lacked the directory the agent CLIs live in, a Node too old to run fleetx.
 *
 * `fleetx doctor` is this area, shown on its own.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { defineArea } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";
import { gitConfigPath, gitEnv } from "../Git.ts";

const Observed = Schema.Struct({
  node: Schema.String,
  /** `url.<x>.insteadOf` rules that rewrite GitHub HTTPS to SSH, as `x -> y`. */
  githubToSsh: Schema.Array(Schema.String),
  /** Whether git can reach the config repo's remote without a terminal. */
  remote: Schema.NullOr(Schema.Struct({ url: Schema.String, reachable: Schema.Boolean, detail: Schema.String })),
  localBinOnPath: Schema.Boolean,
  fleetxGitConfig: Schema.Boolean,
});

const MIN_NODE_MAJOR = 24;

/** The same file Git.ensureGitConfig writes, for a node fleetx is not installed on. */
const GIT_CONFIG_SCRIPT = `mkdir -p ~/.config/fleetx && {
  printf '[user]\\n\\tname = %s\\n\\temail = %s\\n' "$(git config --global user.name || echo fleetx)" "$(git config --global user.email || echo fleetx@localhost)"
  if gh=$(command -v gh); then printf '[credential "https://github.com"]\\n\\thelper =\\n\\thelper = !%s auth git-credential\\n' "$gh"; fi
} > ~/.config/fleetx/gitconfig`;

export const RuntimeArea = defineArea({
  id: "runtime",
  description: "what fleetx and T3 run on: Node, git transport, PATH",
  desired: Schema.Unknown,
  observed: Observed,
  observe: (_desired, ctx) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const rewrites = yield* exec({ command: "git", args: ["config", "--global", "--get-regexp", "^url\\..*\\.insteadof$"], timeout: Duration.seconds(5) });
      const githubToSsh = rewrites.stdout
        .split("\n")
        .map((l) => /^url\.(.+)\.insteadof (.+)$/i.exec(l.trim()))
        .filter((m): m is RegExpExecArray => m !== null && /github\.com/.test(m[2] ?? "") && /^(git@|ssh:)/.test(m[1] ?? ""))
        .map((m) => `${m[2]} -> ${m[1]}`);
      const fleetxGitConfig = (yield* exec({ command: "test", args: ["-f", gitConfigPath(ctx.home)], timeout: Duration.seconds(2) })).code === 0;
      // Read through fleetx's git env: the user's insteadOf rules would show a rewritten URL.
      const url = yield* exec({
        command: "git",
        args: ["-C", ctx.checkout, "remote", "get-url", "origin"],
        env: gitEnv(ctx.home, ctx.env),
        timeout: Duration.seconds(5),
      });
      let remote: typeof Observed.Type["remote"] = null;
      if (url.code === 0 && fleetxGitConfig) {
        // As fleetx's sync timer would: its own git config, no prompts, no SSH agent.
        const ls = yield* exec({
          command: "git",
          args: ["-C", ctx.checkout, "ls-remote", "--heads", "origin"],
          env: { ...gitEnv(ctx.home, ctx.env), SSH_AUTH_SOCK: "" },
          timeout: Duration.seconds(20),
        });
        remote = {
          url: url.stdout.trim(),
          reachable: ls.code === 0,
          detail: ls.code === 0 ? "" : (ls.stderr.trim().split("\n").pop() ?? `exit ${ls.code}`).slice(0, 200),
        };
      }
      return {
        node: process.versions.node,
        githubToSsh,
        remote,
        localBinOnPath: (ctx.env["PATH"] ?? "")
          .split(":")
          // Installers write entries like ~/.local/share/../bin; compare resolved paths.
          .map((d) => path.normalize(d.replace(/^~(?=\/)/, ctx.home)).replace(/\/+$/, ""))
          .includes(`${ctx.home}/.local/bin`),
        fleetxGitConfig,
      };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    const base = { node, area: "runtime" as const };
    const major = Number(observed.node.split(".")[0]);
    if (major < MIN_NODE_MAJOR) {
      out.push({ ...base, key: "node-too-old", severity: "error", title: `Node ${observed.node} is older than ${MIN_NODE_MAJOR}; fleetx and T3 need ${MIN_NODE_MAJOR}+` });
    }
    if (!observed.fleetxGitConfig) {
      out.push({
        ...base,
        key: "fleetx-git-config-missing",
        severity: "warn",
        title: "fleetx's own git config is missing, so sync would use whatever the user's git config says",
        fix: {
          command: GIT_CONFIG_SCRIPT,
          safe: true,
        },
      });
    }
    if (observed.remote !== null && !observed.remote.reachable) {
      const ssh = /^(git@|ssh:)/.test(observed.remote.url);
      out.push({
        ...base,
        key: "remote-unreachable",
        severity: "error",
        title: "the config repo's remote is unreachable without a terminal, so sync cannot run",
        detail: observed.remote.detail,
        ...(ssh
          ? {
              fix: {
                command: `git -C "$FLEETX_CHECKOUT" remote set-url origin ${observed.remote.url.replace(/^git@github\.com:/, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")}`,
                safe: true,
              },
            }
          : {}),
      });
    }
    if (observed.githubToSsh.length > 0) {
      out.push({
        ...base,
        key: "git-rewrites-to-ssh",
        severity: "info",
        title: `git rewrites GitHub HTTPS to SSH (${observed.githubToSsh.join(", ")})`,
        detail: "fleetx's own git ignores this rule; other unattended git (T3 auto-pull, scripts) cannot use an SSH agent",
      });
    }
    if (!observed.localBinOnPath) {
      out.push({ ...base, key: "local-bin-not-on-path", severity: "warn",
        title: "~/.local/bin is not on the login PATH, where fleetx installs agent CLIs",
        detail: "login shells (and so fleetx over ssh, and timers) cannot find the managed claude and codex",
        fix: { command: `printf '\\n# Added by fleetx: agent CLIs live here.\\nexport PATH="$HOME/.local/bin:$PATH"\\n' >> ~/.profile`, safe: false },
      });
    }
    return out;
  },
});
