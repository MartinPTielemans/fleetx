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
import {
  BUNDLE_FILE,
  CLI,
  LEGACY_CLI,
  launchdLabel,
  PRODUCT,
  SHARE_DIR,
  systemdUnit,
} from "./Names.ts";

export interface FixOutcome {
  readonly finding: Finding & { readonly fix: Fix };
  readonly ok: boolean;
  /** Last meaningful line of output, for the report. */
  readonly summary: string;
}

const lastLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop() ?? "";

/**
 * Every fix runs with T3_FLEET_CHECKOUT (and FLEETX_CHECKOUT, until 1.0) set
 * to that node's clone of the config repo, and ~/.local/bin on PATH, where
 * t3-fleet and the agent CLIs live. ENGINE_INSTALL is replaced by this build,
 * streamed inline as base64, and linked as t3-fleet and, until 1.0, fleetx.
 */
const script = (command: string, checkout: string, bundle: string) => {
  const share = `~/${SHARE_DIR}`;
  // A link that already points here (a development checkout) is left alone; a real file in the way is kept aside.
  const link = (name: string) => [
    `[ -e ~/.local/bin/${name} ] && [ ! -L ~/.local/bin/${name} ] && mv ~/.local/bin/${name} ~/.local/bin/${name}.t3-fleet-backup`,
    `ln -sfn ${share}/${BUNDLE_FILE} ~/.local/bin/${name}`,
  ];
  const body =
    command === ENGINE_INSTALL
      ? [
          `mkdir -p ${share} ~/.local/bin`,
          `base64 -d > ${share}/${BUNDLE_FILE}.tmp <<'T3_FLEET_BUNDLE'`,
          Buffer.from(bundle)
            .toString("base64")
            .replace(/(.{76})/g, "$1\n"),
          "T3_FLEET_BUNDLE",
          `chmod 755 ${share}/${BUNDLE_FILE}.tmp && mv ${share}/${BUNDLE_FILE}.tmp ${share}/${BUNDLE_FILE}`,
          ...link(CLI),
          ...link(LEGACY_CLI),
          // Long-running services hold the old build until restarted. The model proxy is not
          // restarted: it notices the new build and exits once its responses are done.
          `if [ "$(uname)" = Darwin ]; then for l in ${launchdLabel("serve")} ${launchdLabel("listen")}; do launchctl kickstart -k "gui/$(id -u)/$l" 2>/dev/null || true; done`,
          `elif [ "$(id -u)" = 0 ]; then systemctl try-restart ${systemdUnit("serve")}.service ${systemdUnit("listen")}.service 2>/dev/null || true`,
          `else systemctl --user try-restart ${systemdUnit("serve")}.service ${systemdUnit("listen")}.service 2>/dev/null || true; fi`,
          `echo installed ${PRODUCT}`,
        ].join("\n")
      : command;
  // On a machine not upgraded yet only fleetx exists; fixes that call t3-fleet run it instead. Until 1.0.
  const alias = `command -v ${CLI} >/dev/null 2>&1 || ${CLI}() { ${LEGACY_CLI} "$@"; }`;
  return `export T3_FLEET_CHECKOUT=${shPath(checkout)} FLEETX_CHECKOUT=${shPath(checkout)}\nexport PATH="$HOME/.local/bin:$PATH"\n${alias}\n${body}\n`;
};

export const runFix = (
  node: Node,
  finding: Finding & { readonly fix: Fix },
  checkout: string,
  bundle: string,
) =>
  Effect.gen(function* () {
    // Installing an empty bundle would leave the node without T3 Fleet.
    if (finding.fix.command === ENGINE_INSTALL && bundle === "") {
      return {
        finding,
        ok: false,
        summary: `no ${PRODUCT} build to install was given; nothing was changed`,
      } satisfies FixOutcome;
    }
    const run = yield* exec(
      node.ssh === null
        ? {
            command: "bash",
            args: ["-l", "-s"],
            stdin: script(finding.fix.command, checkout, bundle),
            timeout: Duration.minutes(10),
          }
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
      : (run.spawnError ??
        (lastLine(ok ? run.stdout || run.stderr : run.stderr || run.stdout) || `exit ${run.code}`));
    return { finding, ok, summary: summary.slice(0, 240) } satisfies FixOutcome;
  });

/**
 * Installing this build comes first on a node, then moving fleetx's
 * directories, then the rest in report order: a unit installed earlier starts
 * a run at once, and that run must find the new build. Until 1.0 the move
 * matters too, since an old build would put back what the rename retired.
 */
const rank = (f: Finding & { readonly fix: Fix }) =>
  f.fix.command === ENGINE_INSTALL ? 0 : f.key === "engine-legacy-dirs" ? 1 : 2;

export const inRunOrder = <F extends Finding & { readonly fix: Fix }>(
  fixes: ReadonlyArray<F>,
): ReadonlyArray<F> =>
  fixes
    .map((f, i) => [f, i] as const)
    .sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j)
    .map(([f]) => f);

/**
 * Fixes for one node run in order (an upgrade may depend on the one before); nodes run in parallel.
 * `localRepo` is the repo this machine loaded, which is what its probe observed; other nodes use `checkout`.
 */
export const runFixes = (
  nodes: ReadonlyArray<Node>,
  fixes: ReadonlyArray<Finding & { readonly fix: Fix }>,
  checkout: string,
  bundle = "",
  localRepo?: string,
) =>
  Effect.forEach(
    nodes,
    (node) =>
      Effect.forEach(inRunOrder(fixes.filter((f) => (f.fix.on ?? f.node) === node.name)), (f) =>
        runFix(
          node,
          f,
          node.ssh === null && localRepo !== undefined ? localRepo : checkout,
          bundle,
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((perNode) => perNode.flat()));
