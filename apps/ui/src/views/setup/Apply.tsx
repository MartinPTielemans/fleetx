/**
 * Doing it: the "setup" job here, then the "setup-hub" job on the hub, a
 * step at a time. The jobs run in the server, so a reload finds them where
 * they are. A run that failed, or one that stopped before this page saw it
 * (stage "unfinished"), continues with resume or is abandoned.
 */
import type { UiSetupState } from "@t3-fleet/core/SetupApi";
import {
  ArrowRightIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  LaptopIcon,
  RotateCcwIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ConfirmDialog, Failure } from "../../components/dialogs";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import type { UiJobT } from "../../lib/api";
import { finished as jobFinished } from "../../lib/jobs";
import { ago, cn, plural } from "../../lib/utils";
import { CopyCommand, Prose, StepFrame } from "./parts";
import { runJobs, type JobListing, type SetupRun } from "./run";
import { stepIndex, stepStates, type StepState } from "./wizard";

export function ApplyStep({
  state,
  run,
  listing,
  jobs,
  now,
  onReached,
  onResume,
  onAbandon,
  onNext,
}: {
  state: UiSetupState;
  run: SetupRun | null;
  /** The server's job list as last read: a job of the run it no longer has is gone. */
  listing: JobListing | null;
  jobs: ReadonlyArray<UiJobT>;
  now: number;
  onReached: (job: string, index: number) => void;
  onResume: () => Promise<void>;
  onAbandon: () => Promise<void>;
  onNext: () => void;
}) {
  const { setup, hub, pending } = runJobs(run, jobs, listing);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);
  const [abandoning, setAbandoning] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  /** In the fleet already, abandoning only forgets the hub still to bring up. */
  const forget = async () => {
    setForgetting(true);
    setResumeError(null);
    try {
      await onAbandon();
    } catch (error) {
      setResumeError(error);
    } finally {
      setForgetting(false);
    }
  };
  const resume = async () => {
    setResuming(true);
    setResumeError(null);
    try {
      await onResume();
    } catch (error) {
      setResumeError(error);
    } finally {
      setResuming(false);
    }
  };

  // The hub's part: as this tab planned it, or as the server says one is still to bring up.
  const hubPart =
    run?.hub ??
    (state.hub === null
      ? null
      : { node: state.hub.node, ssh: state.hub.ssh, relayUrl: null, steps: [] });
  const inFleet = state.stage === "member";
  const stopped = !pending && setup === null && hub === null && state.stage === "unfinished";
  // A resume of only the hub's part comes without this computer's job, finished long ago.
  const setupDone = setup?.state === "done" || (setup === null && (hub !== null || inFleet));
  const hubRunning = hub !== null && !jobFinished(hub);
  // No hub job running and none coming (the chain starts it at once): the last try stopped.
  const hubStalled =
    setupDone &&
    hubPart !== null &&
    hub === null &&
    !pending &&
    state.hub !== null &&
    (setup?.finishedAt == null || now - setup.finishedAt > 10_000);
  const hubError =
    hub?.state === "failed"
      ? (hub.error ?? "it stopped")
      : !hubRunning && hub?.state !== "done" && (state.hub?.error != null || hubStalled)
        ? (state.hub?.error ?? null)
        : null;
  const hubStopped =
    hub?.state === "failed" ||
    (!hubRunning && (state.hub?.error != null || hubStalled) && setupDone);
  const finished =
    setupDone &&
    (hubPart === null ||
      hub?.state === "done" ||
      (inFleet && state.hub === null && !hubRunning && !pending));
  const failed = setup?.state === "failed" ? "setup" : hubStopped ? "hub" : null;

  const title = stopped
    ? "Setup stopped part-way"
    : finished
      ? "All set"
      : failed === "setup"
        ? "Setup stopped"
        : failed === "hub"
          ? "The hub's part stopped"
          : "Setting up";
  const lead = stopped ? (
    <>
      A setup started {state.unfinished === null ? "earlier" : ago(state.unfinished.startedAt, now)}{" "}
      and stopped
      {state.unfinished === null
        ? ""
        : ` after ${state.unfinished.done} of ${plural(state.unfinished.total, "step")}`}
      . Continuing does what was decided then, from the step where it stopped. Abandoning keeps what
      it did already.
    </>
  ) : finished ? (
    run?.commits === false ? (
      "Everything in the plan ran. What this computer brought now waits for the authority's approval."
    ) : (
      "Everything in the plan ran. Next, bring in your other machines."
    )
  ) : failed === "hub" ? (
    <>
      This computer is set up and in the fleet; bringing up {hubPart?.node ?? "the hub"} stopped.
      Fix what the error says there and try again, or go on without a hub for now and add one later.
    </>
  ) : failed !== null ? (
    "What ran is kept and recorded. Fix what the error says, then try again: it continues from the step that stopped."
  ) : (
    "This runs in t3-fleet ui, not in this tab: closing or reloading the page doesn't stop it."
  );

  return (
    <StepFrame
      title={title}
      lead={lead}
      actions={
        stopped || failed !== null ? (
          <>
            {failed === "hub" ? (
              <Button
                variant="outline"
                disabled={resuming || forgetting}
                onClick={() => void forget()}
              >
                {forgetting ? <Spinner className="size-3.5" /> : null}
                Go on without the hub
              </Button>
            ) : (
              <Button variant="ghost-muted" disabled={resuming} onClick={() => setAbandoning(true)}>
                <Trash2Icon />
                Abandon
              </Button>
            )}
            <Button disabled={resuming} onClick={() => void resume()}>
              {resuming ? <Spinner className="size-3.5" /> : <RotateCcwIcon />}
              {stopped ? "Continue setup" : failed === "hub" ? "Try the hub again" : "Try again"}
            </Button>
          </>
        ) : (
          <Button disabled={!finished} onClick={onNext}>
            {finished ? null : <Spinner className="size-3.5" />}
            {finished ? (run?.commits === false ? "Continue" : "Add your machines") : "Working"}
            {finished ? <ArrowRightIcon /> : null}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <Failure error={resumeError} />
        <Overall
          run={run}
          setup={setup}
          setupDone={setupDone}
          hub={hub}
          state={state}
          stopped={stopped}
        />
        <JobSteps
          icon={<LaptopIcon />}
          title={`This computer${run === null ? "" : ` · ${run.node}`}`}
          steps={run?.steps ?? []}
          job={setup}
          assumeDone={setup === null && setupDone}
          reached={setup === null ? -1 : (run?.reached[setup.id] ?? -1)}
          stoppedAt={stopped ? (state.unfinished?.done ?? 0) : null}
          onReached={onReached}
          now={now}
        />
        {hubPart === null ? null : (
          <JobSteps
            icon={<ServerIcon />}
            title={`The hub · ${hubPart.node}`}
            steps={hubPart.steps}
            job={hub}
            error={hub === null ? hubError : null}
            reached={hub === null ? -1 : (run?.reached[hub.id] ?? -1)}
            stoppedAt={null}
            onReached={onReached}
            now={now}
            waiting={!setupDone ? "After this computer" : null}
          />
        )}
        {failed === "hub" ? (
          <div className="flex flex-col gap-1.5 text-muted-foreground text-xs leading-5">
            Only this page brings up the hub. Closed it? Open it again on this computer, and try the
            hub from here:
            <CopyCommand command="t3-fleet ui --local" className="max-w-sm" />
          </div>
        ) : failed !== null || stopped ? (
          <div className="flex flex-col gap-1.5 text-muted-foreground text-xs leading-5">
            The same from a terminal on this computer:
            <CopyCommand command="t3-fleet setup --resume" className="max-w-sm" />
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={abandoning}
        title="Abandon this setup?"
        description="What it did already stays on this computer. The next setup starts from the beginning and picks up what this one left behind."
        confirm="Abandon setup"
        variant="destructive"
        icon={<Trash2Icon />}
        onConfirm={onAbandon}
        onClose={() => setAbandoning(false)}
      />
    </StepFrame>
  );
}

/** The bar across the top: how much of the whole run is done. */
function Overall({
  run,
  setup,
  setupDone,
  hub,
  state,
  stopped,
}: {
  run: SetupRun | null;
  setup: UiJobT | null;
  setupDone: boolean;
  hub: UiJobT | null;
  state: UiSetupState;
  stopped: boolean;
}) {
  const here = run?.steps.length ?? 0;
  const there = run?.hub?.steps.length ?? 0;
  const count = (job: UiJobT | null, n: number) => {
    if (job === null || n === 0) return 0;
    if (job.state === "done") return n;
    return Math.max(0, run?.reached[job.id] ?? 0);
  };
  const total = stopped ? (state.unfinished?.total ?? 1) : Math.max(1, here + there);
  const done = stopped
    ? (state.unfinished?.done ?? 0)
    : (setupDone ? here : count(setup, here)) + count(hub, there);
  const failed = setup?.state === "failed" || hub?.state === "failed";
  const complete = !stopped && done >= total && here > 0;
  // No steps known (a run planned elsewhere) and none counted: nothing to measure.
  if (!stopped && here + there === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">
          {complete ? "Done" : `${done} of ${plural(total, "step")}`}
        </span>
        {setup?.finishedAt == null || setup.startedAt === 0 ? null : (
          <span className="text-muted-foreground tabular-nums">
            {Math.max(
              1,
              Math.round(((hub?.finishedAt ?? setup.finishedAt) - setup.startedAt) / 1000),
            )}
            s
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1.5 overflow-hidden rounded-full bg-accent"
      >
        <div
          className={cn(
            "h-full w-full origin-left rounded-full transition-[transform,background-color] duration-500 ease-(--ease-out-strong)",
            failed || stopped ? "bg-warning" : complete ? "bg-success" : "bg-primary",
          )}
          style={{ transform: `scaleX(${Math.min(1, done / total)})` }}
        />
      </div>
    </div>
  );
}

/**
 * One job's steps. With the plan's steps known, each is ticked off as the job
 * reports it; without them (a run resumed from elsewhere) the steps it has
 * reported are listed as they come.
 */
function JobSteps({
  icon,
  title,
  steps,
  job,
  error = null,
  assumeDone = false,
  reached,
  stoppedAt,
  onReached,
  now,
  waiting = null,
}: {
  icon: ReactNode;
  title: string;
  steps: ReadonlyArray<string>;
  job: UiJobT | null;
  /** Why it stopped, when no job of this page's says so. */
  error?: string | null;
  /** Its part finished in an earlier job this page no longer has. */
  assumeDone?: boolean;
  reached: number;
  /** For a stopped run: how many steps it finished. */
  stoppedAt: number | null;
  onReached: (job: string, index: number) => void;
  now: number;
  waiting?: string | null;
}) {
  const [seen, setSeen] = useState<ReadonlyArray<string>>([]);
  const last = useRef<string | null>(null);
  const step = job?.step ?? null;
  useEffect(() => {
    if (job === null || step === null || step === last.current) return;
    last.current = step;
    const i = stepIndex(steps, step);
    if (i > reached) onReached(job.id, i);
    if (steps.length === 0 && !/^(?:starting|waiting)/.test(step))
      setSeen((s) => (s.includes(step) ? s : [...s, step]));
  }, [job, step, steps, reached, onReached]);

  const list = steps.length > 0 ? steps : seen;
  const states: ReadonlyArray<StepState> = assumeDone
    ? list.map(() => "done")
    : stoppedAt !== null
      ? list.map((_, i) => (i < stoppedAt ? "done" : i === stoppedAt ? "failed" : "waiting"))
      : steps.length > 0
        ? stepStates(steps.length, job, reached)
        : list.map((_, i) =>
            i < list.length - 1 || job?.state === "done"
              ? "done"
              : job?.state === "failed"
                ? "failed"
                : "running",
          );
  const failedAt = states.indexOf("failed");
  const status = assumeDone
    ? "Done"
    : job === null
      ? (waiting ?? (stoppedAt !== null || error !== null ? "Stopped" : "Waiting"))
      : job.state === "done"
        ? "Done"
        : job.state === "failed"
          ? "Stopped"
          : job.state === "waiting"
            ? "Waiting for another change to finish"
            : `Started ${ago(job.startedAt, now)}`;
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-xl border bg-card/50 shadow-xs/5"
    >
      <header className="flex items-center gap-2.5 border-b px-4 py-2.5 [&_svg]:size-4">
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
        <span
          className={cn(
            "text-xs",
            job?.state === "done"
              ? "text-success-foreground"
              : job?.state === "failed"
                ? "text-destructive-foreground"
                : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      </header>
      {list.length === 0 ? (
        <div className="flex items-center gap-3 px-4 py-3 text-muted-foreground text-sm">
          {job !== null && job.state !== "done" && job.state !== "failed" ? (
            <Spinner className="size-4" />
          ) : null}
          {job?.step ??
            (assumeDone
              ? "Set up, and in the fleet."
              : stoppedAt !== null
                ? `Stopped after ${plural(stoppedAt, "step")}; continuing starts at the next one.`
                : job === null
                  ? waiting !== null
                    ? "Brought up once this computer's part is done."
                    : error !== null
                      ? "The last try stopped:"
                      : "Not started"
                  : job.state === "done"
                    ? "Done"
                    : "Starting")}
        </div>
      ) : (
        <ol aria-live="polite" className="flex flex-col py-1.5">
          {list.map((text, i) => {
            const s = states[i] ?? "waiting";
            return (
              <li
                key={`${i}:${text}`}
                aria-current={s === "running" ? "step" : undefined}
                className={cn(
                  "flex flex-col gap-2 px-4 py-1.5 transition-colors duration-300",
                  s === "running" && "bg-primary/[0.04] dark:bg-primary/[0.08]",
                  s === "failed" && "bg-error-surface",
                )}
              >
                <div className="flex items-start gap-3">
                  <StepMark state={s} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-pretty text-sm leading-5 transition-colors duration-300",
                      s === "waiting" && "text-muted-foreground",
                      s === "running" && "font-medium",
                      s === "failed" && "font-medium text-destructive-foreground",
                    )}
                  >
                    <Prose text={text} />
                  </span>
                </div>
                {s === "running" &&
                job?.step != null &&
                stepIndex(steps, job.step) !== i &&
                steps.length > 0 ? (
                  <span className="pl-7 text-muted-foreground text-xs">{job.step}</span>
                ) : null}
                {i === failedAt && job?.error != null ? (
                  <pre className="ml-7 whitespace-pre-wrap break-words rounded-md border border-destructive/20 bg-background/70 px-2.5 py-2 font-mono text-destructive-foreground text-xs leading-5">
                    {job.error}
                  </pre>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {failedAt === -1 && (job?.state === "failed" ? job.error : error) != null ? (
        <pre className="mx-4 my-3 whitespace-pre-wrap break-words rounded-md border border-destructive/20 bg-error-surface px-2.5 py-2 font-mono text-destructive-foreground text-xs leading-5">
          {job?.state === "failed" ? job.error : error}
        </pre>
      ) : null}
    </section>
  );
}

function StepMark({ state }: { state: StepState }) {
  const base = "mt-0.5 size-4 shrink-0";
  switch (state) {
    case "done":
      return (
        <CircleCheckIcon
          aria-label="done"
          className={cn(base, "text-success motion-safe:animate-fade-in")}
        />
      );
    case "running":
      return <Spinner aria-label="running" className={cn(base, "text-primary")} />;
    case "failed":
      return <CircleXIcon aria-label="stopped" className={cn(base, "text-destructive")} />;
    case "waiting":
      return <CircleIcon aria-label="to do" className={cn(base, "text-muted-foreground/40")} />;
  }
}
