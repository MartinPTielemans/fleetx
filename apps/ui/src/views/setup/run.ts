/**
 * A setup run as this browser saw it start: the jobs, the steps the plan
 * promised, and the machines still to add. The jobs themselves live in the
 * server and come back on reconnect; this keeps what only the plan said, so
 * a reload mid-run still shows every step, and the invite screen survives
 * until "Open your fleet".
 */
import type { UiJob } from "@t3-fleet/core/Api";

export interface SetupRun {
  /** The job apply last answered with ("setup", or "setup-hub" for a resume of only the hub); null before. */
  readonly job: string | null;
  readonly startedAt: number;
  readonly node: string;
  /** Every step apply runs here, from the plan; empty for a run resumed without one. */
  readonly steps: ReadonlyArray<string>;
  readonly hub: {
    readonly node: string;
    readonly ssh: string;
    readonly relayUrl: string | null;
    /** It hosts the fleet's MCP servers: each needs its sign-in there. */
    readonly mcp?: boolean;
    readonly steps: ReadonlyArray<string>;
  } | null;
  /** What setup set for looking after the machines (the plan's settings), for the last screen. */
  readonly settings?: ReadonlyArray<string>;
  /** The repository's remote; without one there is nothing for another machine to join yet. */
  readonly remote?: string | null;
  /** How many other machines the user said they have, for the invites. */
  readonly others: number;
  /** The furthest step each job reported, by job id: a failed job reports none. */
  readonly reached: Readonly<Record<string, number>>;
  /** Setup finished; the invite screen shows until the fleet is opened. */
  readonly finished: boolean;
}

const KEY = "t3-fleet:setup-run";

export const loadRun = (): SetupRun | null => {
  try {
    const text = window.localStorage.getItem(KEY);
    return text === null ? null : (JSON.parse(text) as SetupRun);
  } catch {
    return null;
  }
};

export const saveRun = (run: SetupRun | null) => {
  if (run === null) window.localStorage.removeItem(KEY);
  else window.localStorage.setItem(KEY, JSON.stringify(run));
};

/**
 * The run's two jobs, as the store knows them. `run.job` is the job apply
 * last answered with: the "setup" job, or the "setup-hub" one when a resume
 * only had the hub's part left. Until that job's first event arrives the
 * run is `pending`.
 */
export const runJobs = (run: SetupRun | null, jobs: ReadonlyArray<UiJob>) => {
  const pinned = run?.job == null ? undefined : jobs.find((j) => j.id === run.job);
  const setups = jobs.filter((j) => j.kind === "setup");
  const setup =
    pinned === undefined
      ? run?.job == null
        ? (setups.at(-1) ?? null)
        : null
      : pinned.kind === "setup"
        ? pinned
        : (setups.filter((j) => j.startedAt <= pinned.startedAt).at(-1) ?? null);
  const since = setup?.startedAt ?? pinned?.startedAt ?? Number.POSITIVE_INFINITY;
  const hub = jobs.filter((j) => j.kind === "setup-hub" && j.startedAt >= since).at(-1) ?? null;
  return { setup, hub, pending: run?.job != null && pinned === undefined };
};
