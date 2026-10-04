/**
 * Which T3 Fleet build a bundle is: its version, when it was built, and the
 * commit it was built from. `vp pack` writes one marker into the bundle
 * (apps/cli/vite.config.ts), so the identity can be read back from any copy's
 * text: the controller's, and the one installed on a node. Two hashes only
 * say that builds differ; this says which one is newer.
 */
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const BuildId = Schema.Struct({
  version: Schema.String,
  /** Milliseconds since the epoch. */
  builtAt: Schema.Number,
  /** Short commit hash, with "-dirty" for uncommitted changes; null when built outside git. */
  commit: Schema.NullOr(Schema.String),
});
export type BuildId = typeof BuildId.Type;

/** Put in place of `__T3_FLEET_BUILD__` by `vp pack`; undefined when running from source. */
declare const __T3_FLEET_BUILD__: string | undefined;

const MARKER = "t3-fleet-build";

/** The marker text for a build: `t3-fleet-build:0.6.1:1759579200000:abc1234`. */
export const buildMarker = (build: BuildId) =>
  `${MARKER}:${build.version}:${build.builtAt}:${build.commit ?? ""}`;

// Assembled at run time, so the bundle's copy of this pattern never matches itself.
const PATTERN = new RegExp(
  `${MARKER}:(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?):(\\d+):([0-9a-f]*(?:-dirty)?)(?![0-9A-Za-z-])`,
);

/** The identity written into a bundle; null for a build from before identities existed. */
export const buildOf = (bundle: string): BuildId | null => {
  const m = PATTERN.exec(bundle);
  if (m === null) return null;
  return {
    version: m[1] ?? "",
    builtAt: Number(m[2]),
    commit: m[3] === "" || m[3] === undefined ? null : m[3],
  };
};

/** This running build's identity; null when running from source. */
export const runningBuild = (): BuildId | null =>
  typeof __T3_FLEET_BUILD__ === "string" ? buildOf(__T3_FLEET_BUILD__) : null;

const parts = (version: string) => {
  const [core = "", pre] = version.split("-", 2);
  return { numbers: core.split(".").map(Number), pre: pre ?? null };
};

/**
 * Positive when `a` is newer than `b`, by version. Two builds of one version
 * are ordered by build time only when they come from the same commit; from
 * different commits (an older branch rebuilt today) neither is known to be
 * newer, and the answer is null.
 */
export const compareBuilds = (a: BuildId, b: BuildId): number | null => {
  const x = parts(a.version);
  const y = parts(b.version);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (d !== 0) return d;
  }
  // A release is newer than its prereleases.
  if (x.pre !== y.pre) {
    if (x.pre === null) return 1;
    if (y.pre === null) return -1;
    return x.pre < y.pre ? -1 : 1;
  }
  const commit = (c: string | null) => c?.replace(/-dirty$/, "") ?? null;
  if (commit(a.commit) === null || commit(a.commit) !== commit(b.commit)) return null;
  return a.builtAt - b.builtAt;
};

/** "0.6.1 built 2026-10-04 12:00 UTC (abc1234)". */
export const describeBuild = (build: BuildId) =>
  `${build.version} built ${DateTime.formatIso(DateTime.makeUnsafe(build.builtAt)).slice(0, 16).replace("T", " ")} UTC${build.commit === null ? "" : ` (${build.commit})`}`;
