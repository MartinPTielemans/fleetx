import type { UiJob } from "@t3-fleet/core/Api";
import { describe, expect, it } from "vite-plus/test";

import { runJobs, type SetupRun } from "./run";

const job = (
  id: string,
  kind: UiJob["kind"],
  startedAt: number,
  state: UiJob["state"] = "done",
): UiJob => ({
  id,
  kind,
  title: id,
  state,
  step: null,
  startedAt,
  finishedAt: state === "done" || state === "failed" ? startedAt + 1 : null,
  error: null,
  applied: null,
  landed: null,
});

const run = (jobId: string | null): SetupRun => ({
  job: jobId,
  startedAt: 0,
  node: "laptop",
  steps: [],
  hub: null,
  others: 0,
  reached: {},
  finished: false,
});

describe("runJobs", () => {
  const old = job("old", "setup", 1, "failed");
  const setup = job("s", "setup", 10);
  const hub = job("h", "setup-hub", 20, "running");

  it("pairs the run's setup job with the hub job after it", () => {
    expect(runJobs(run("s"), [old, setup, hub])).toEqual({ setup, hub, pending: false });
  });

  it("waits for a job apply answered with before its first event, not an older one", () => {
    expect(runJobs(run("new"), [old])).toEqual({ setup: null, hub: null, pending: true });
  });

  it("follows a resume of only the hub's part", () => {
    const retry = job("h2", "setup-hub", 30, "running");
    expect(runJobs(run("h2"), [setup, hub, retry])).toEqual({
      setup,
      hub: retry,
      pending: false,
    });
    expect(runJobs(run("h2"), [retry])).toEqual({ setup: null, hub: retry, pending: false });
  });

  it("without a run, follows the latest setup job", () => {
    expect(runJobs(null, [old, setup]).setup).toBe(setup);
    expect(runJobs(null, []).setup).toBeNull();
  });
});
