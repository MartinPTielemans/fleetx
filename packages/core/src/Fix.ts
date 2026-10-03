/**
 * Running a finding's fix on the machine it belongs to. Commands go to a login
 * shell on stdin (`bash -l -s`), locally or over ssh, so they see the same
 * PATH a person would and need no quoting.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { Finding, Fix } from "./Diagnose.ts";
import { shPath } from "./Area.ts";
import { ENGINE_INSTALL } from "./areas/Engine.ts";
import { exec } from "./Exec.ts";
import type { Node } from "./Config.ts";

export interface FixOutcome {
  readonly finding: Finding & { readonly fix: Fix };
  readonly ok: boolean;
  /** Last meaningful line of output, for the report. */
  readonly summary: string;
}

const lastLine = (text: string) =>
  text.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";

/**
 * Every fix runs with FLEETX_CHECKOUT set to that node's clone of the config
 * repo, and ~/.local/bin on PATH, where fleetx and the agent CLIs live.
 * ENGINE_INSTALL is replaced by this build, streamed inline as base64.
 */
const script = (command: string, checkout: string, bundle: string) => {
  const body =
    command === ENGINE_INSTALL
      ? [
          "mkdir -p ~/.local/share/fleetx ~/.local/bin",
          "base64 -d > ~/.local/share/fleetx/fleetx.mjs.tmp <<'FLEETX_BUNDLE'",
          Buffer.from(bundle).toString("base64").replace(/(.{76})/g, "$1\n"),
          "FLEETX_BUNDLE",
          "chmod 755 ~/.local/share/fleetx/fleetx.mjs.tmp && mv ~/.local/share/fleetx/fleetx.mjs.tmp ~/.local/share/fleetx/fleetx.mjs",
          // A link that already points here (a development checkout) is left alone.
          '[ -e ~/.local/bin/fleetx ] && [ "$(readlink ~/.local/bin/fleetx)" != "$HOME/.local/share/fleetx/fleetx.mjs" ] && [ ! -L ~/.local/bin/fleetx ] && mv ~/.local/bin/fleetx ~/.local/bin/fleetx.fleetx-backup',
          "ln -sfn ~/.local/share/fleetx/fleetx.mjs ~/.local/bin/fleetx",
          "echo installed fleetx",
        ].join("\n")
      : command;
  return `export FLEETX_CHECKOUT=${shPath(checkout)}\nexport PATH="$HOME/.local/bin:$PATH"\n${body}\n`;
};

export const runFix = (node: Node, finding: Finding & { readonly fix: Fix }, checkout: string, bundle: string) =>
  Effect.gen(function* () {
    const run = yield* exec(
      node.ssh === null
        ? { command: "bash", args: ["-l", "-s"], stdin: script(finding.fix.command, checkout, bundle), timeout: Duration.minutes(10) }
        : {
            command: "ssh",
            args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", node.ssh, "bash -l -s"],
            env: process.env,
            stdin: script(finding.fix.command, checkout, bundle),
            timeout: Duration.minutes(10),
          },
    );
    const ok = run.code === 0;
    const summary = run.timedOut
      ? "timed out after 10 minutes"
      : run.spawnError ?? (lastLine(ok ? run.stdout || run.stderr : run.stderr || run.stdout) || `exit ${run.code}`);
    return { finding, ok, summary: summary.slice(0, 240) } satisfies FixOutcome;
  });

/** Fixes for one node run in order (an upgrade may depend on the one before); nodes run in parallel. */
export const runFixes = (
  nodes: ReadonlyArray<Node>,
  fixes: ReadonlyArray<Finding & { readonly fix: Fix }>,
  checkout: string,
  bundle = "",
) =>
  Effect.forEach(
    nodes,
    (node) => Effect.forEach(fixes.filter((f) => (f.fix.on ?? f.node) === node.name), (f) => runFix(node, f, checkout, bundle)),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((perNode) => perNode.flat()));
