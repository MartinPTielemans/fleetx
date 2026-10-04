/**
 * Jobs this tab did not start, or started before a reload: fixes, approvals,
 * skill changes running in `t3-fleet ui`. Each shows what it is doing and,
 * when done, how it went.
 */
import { CheckCircle2Icon, CircleXIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { UiJobT } from "../lib/api";
import { finished } from "../lib/jobs";
import { useStore } from "../lib/store";
import { ActionDialog } from "./dialogs";
import { AppliedList, appliedTitle } from "./fixes";
import {
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

/** Finished jobs this recent still show after a reload. */
const RECENT_MS = 10 * 60_000;
const loadedAt = Date.now();

const outcome = (job: UiJobT) => {
  if (job.state === "failed") return job.error ?? "failed";
  if (job.applied !== null)
    return appliedTitle(job.applied, job.applied.results.length + job.applied.notApplied.length);
  if (job.landed !== null) return job.landed.landed;
  return "done";
};

export function JobsTray() {
  const { jobs, watched } = useStore();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState<UiJobT | null>(null);
  const shown = jobs.filter(
    (j) =>
      !watched.has(j.id) &&
      !dismissed.has(j.id) &&
      (!finished(j) || (j.finishedAt !== null && j.finishedAt >= loadedAt - RECENT_MS)),
  );
  if (shown.length === 0 && details === null) return null;
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="fixed right-4 bottom-4 z-40 flex w-80 flex-col gap-2"
      >
        {shown.map((job) => (
          <div
            key={job.id}
            className="flex items-start gap-2 rounded-xl border surface-glass px-3 py-2.5 text-sm shadow-lg/10"
          >
            {!finished(job) ? (
              <Spinner className="mt-0.5 size-3.5 shrink-0" />
            ) : job.state === "done" ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{job.title}</div>
              <div className="break-words text-muted-foreground text-xs">
                {finished(job) ? outcome(job) : `${job.step ?? job.state}…`}
              </div>
              {job.applied !== null ? (
                <button
                  type="button"
                  onClick={() => setDetails(job)}
                  className="mt-1 cursor-pointer text-xs underline-offset-2 hover:underline"
                >
                  Show what ran
                </button>
              ) : null}
            </div>
            {finished(job) ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Dismiss ${job.title}`}
                onClick={() => setDismissed((d) => new Set(d).add(job.id))}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
      <ActionDialog
        open={details !== null}
        busy={false}
        onClose={() => setDetails(null)}
        className="max-w-2xl"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{details?.title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-2">
          {details?.applied == null ? null : <AppliedList applied={details.applied} />}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button />}>Done</AlertDialogClose>
        </AlertDialogFooter>
      </ActionDialog>
    </>
  );
}
