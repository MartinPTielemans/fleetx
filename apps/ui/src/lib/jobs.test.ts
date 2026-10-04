import type { UiJob } from "@t3-fleet/core/Api";
import { describe, expect, it } from "vite-plus/test";

import { JobBook } from "./jobs";

const job = (state: UiJob["state"]): UiJob => ({
  id: "j1",
  kind: "fixes",
  title: "Apply 1 fix on 1 machine",
  state,
  step: null,
  startedAt: 1,
  finishedAt: state === "done" || state === "failed" ? 2 : null,
  error: null,
  applied: null,
  landed: null,
});

describe("JobBook", () => {
  it("settles at once when the job's last event came before the answer that started it", async () => {
    const seen: Array<string> = [];
    const book = new JobBook((jobs) => seen.push(jobs.get("j1")?.state ?? "-"));
    book.update(job("running"));
    book.update(job("done"));
    // The 202, still saying it waits.
    await expect(book.settled(job("waiting"))).resolves.toMatchObject({ state: "done" });
    expect(seen.at(-1)).toBe("done");
  });

  it("waits for the event when the answer comes first", async () => {
    const book = new JobBook(() => undefined);
    let settled: UiJob | null = null;
    const waiting = book.settled(job("waiting")).then((j) => (settled = j));
    await Promise.resolve();
    expect(settled).toBeNull();
    book.update(job("running"));
    book.update(job("failed"));
    await waiting;
    expect(settled).toMatchObject({ state: "failed" });
  });
});
