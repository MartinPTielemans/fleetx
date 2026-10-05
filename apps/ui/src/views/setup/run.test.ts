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

const run = (jobId: string | null, startedAt = 0): SetupRun => ({
  job: jobId,
  startedAt,
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
    expect(runJobs(run("s"), [old, setup, hub])).toEqual({
      setup,
      hub,
      pending: false,
      gone: false,
    });
  });

  it("waits for a job apply answered with before its first event, not an older one", () => {
    expect(runJobs(run("new"), [old])).toEqual({
      setup: null,
      hub: null,
      pending: true,
      gone: false,
    });
  });

  it("follows a resume of only the hub's part", () => {
    const retry = job("h2", "setup-hub", 30, "running");
    expect(runJobs(run("h2"), [setup, hub, retry])).toEqual({
      setup,
      hub: retry,
      pending: false,
      gone: false,
    });
    expect(runJobs(run("h2"), [retry])).toEqual({
      setup: null,
      hub: retry,
      pending: false,
      gone: false,
    });
  });

  it("without a run, follows the latest setup job", () => {
    expect(runJobs(null, [old, setup]).setup).toBe(setup);
    expect(runJobs(null, []).setup).toBeNull();
  });

  it("takes a job the server's list no longer has as gone, not pending, so the page reads the state", () => {
    const listed = (at: number, ...ids: Array<string>) => ({ at, ids: new Set(ids) });
    // Reloaded after the server dropped the finished job: not waiting for it forever.
    expect(runJobs(run("s", 5), [], listed(100))).toEqual({
      setup: null,
      hub: null,
      pending: false,
      gone: true,
    });
    // The hub's job, started after it, is still followed.
    expect(runJobs(run("s", 5), [hub], listed(100, "h"))).toMatchObject({ hub, gone: true });
    // Listed, but its event not here yet: still pending.
    expect(runJobs(run("s", 5), [], listed(100, "s"))).toMatchObject({
      pending: true,
      gone: false,
    });
    // A list read before apply answered says nothing about the job it started.
    expect(runJobs(run("new", 200), [], listed(100))).toMatchObject({
      pending: true,
      gone: false,
    });
  });
});
