/**
 * The jobs this page knows, from "job" events and from the answers that
 * started them. The two race: a quick job's last event can arrive before the
 * answer that started it, so a job that finished never goes back to running,
 * and waiting for a job already known to have finished settles at once.
 */
import type { UiJob } from "@t3-fleet/core/Api";

export const finished = (job: UiJob) => job.state === "done" || job.state === "failed";

export class JobBook {
  readonly #known = new Map<string, UiJob>();
  readonly #waiters = new Map<string, Array<(job: UiJob) => void>>();
  readonly #changed: (jobs: ReadonlyMap<string, UiJob>) => void;

  constructor(changed: (jobs: ReadonlyMap<string, UiJob>) => void) {
    this.#changed = changed;
  }

  /** A job as an event or an answer reports it. */
  update(job: UiJob): void {
    const known = this.#known.get(job.id);
    if (known !== undefined && finished(known) && !finished(job)) return;
    this.#known.set(job.id, job);
    this.#changed(new Map(this.#known));
    if (!finished(job)) return;
    for (const resolve of this.#waiters.get(job.id) ?? []) resolve(job);
    this.#waiters.delete(job.id);
  }

  /** The job once it has finished: at once if it already has, whatever `started` says. */
  settled(started: UiJob): Promise<UiJob> {
    this.update(started);
    const now = this.#known.get(started.id) ?? started;
    if (finished(now)) return Promise.resolve(now);
    return new Promise((resolve) => this.#waiters.set(started.id, [...(this.#waiters.get(started.id) ?? []), resolve]));
  }
}
