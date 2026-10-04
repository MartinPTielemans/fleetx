/**
 * Applying fixes the way `t3-fleet fix` does: the exact commands first, what
 * each interrupts marked, an explicit confirmation, then results and a fresh
 * check. The dialog asks the server for a plan when it opens and shows only
 * that, whatever later checks say; applying sends the plan's digests back,
 * and the server runs only fixes still exactly as shown. It runs as a job, so
 * closing the tab does not stop it.
 */
import type { UiFinding } from "@t3-fleet/core/Api";
import { CheckCircle2Icon, CircleXIcon, PlayIcon, WrenchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type UiApplyResultT, type UiFixPlanT } from "../lib/api";
import { useAction, useStore } from "../lib/store";
import { plural } from "../lib/utils";
import { Code } from "./common";
import { ActionDialog, Failure } from "./dialogs";
import { AlertDialogBody, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export type Fixable = UiFinding & { readonly fix: NonNullable<UiFinding["fix"]> };
export const fixable = (f: UiFinding): f is Fixable => f.fix !== undefined;

export const byNode = <T extends { readonly node: string }>(items: ReadonlyArray<T>) => {
  const groups = new Map<string, Array<T>>();
  for (const item of items) groups.set(item.node, [...(groups.get(item.node) ?? []), item]);
  return [...groups.entries()];
};

const machines = (fixes: ReadonlyArray<{ readonly node: string; readonly on?: string }>) => new Set(fixes.map((f) => f.on ?? f.node)).size;

/** What a fix job did. */
export function AppliedList({ applied }: { applied: UiApplyResultT }) {
  return (
    <>
      {applied.results.map((r) => (
        <div key={r.id} className="flex items-start gap-2 text-sm">
          {r.ok ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleXIcon className="mt-0.5 size-4 shrink-0 text-destructive" />}
          <div className="min-w-0">
            <div>
              <span className="font-medium">{r.node}</span> {r.title}
            </div>
            {r.output === "" ? null : <div className="break-words text-muted-foreground text-xs">{r.output}</div>}
          </div>
        </div>
      ))}
      {applied.notApplied.map((n) => (
        <div key={n.id} className="flex items-start gap-2 text-sm">
          <WrenchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <code className="text-xs">{n.id}</code> <span className="text-muted-foreground text-xs">not applied: {n.reason}</span>
          </div>
        </div>
      ))}
    </>
  );
}

export const appliedTitle = (applied: UiApplyResultT, planned: number) =>
  applied.results.every((r) => r.ok) && applied.notApplied.length === 0
    ? `Applied ${plural(applied.results.length, "fix", "fixes")}`
    : `${applied.results.filter((r) => r.ok).length} of ${plural(planned, "fix", "fixes")} applied`;

/** Plans the fixes for `ids` when it opens, shows that plan, asks, applies it, and shows the outcome. */
export function ApplyDialog({ ids, onClose, onApplied }: { ids: ReadonlyArray<string> | null; onClose: () => void; onApplied?: () => void }) {
  const { runJob, jobs } = useStore();
  const [understood, setUnderstood] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const planning = useAction((asked: ReadonlyArray<string>) => api.planFixes(asked));
  const applying = useAction((plan: UiFixPlanT, acknowledged: ReadonlyArray<string>) =>
    runJob(() => api.applyFixes(plan.fixes.map((f) => ({ id: f.id, digest: f.digest })), acknowledged), setJobId),
  );
  const step = jobs.find((j) => j.id === jobId)?.step ?? null;
  const startPlanning = planning.start;
  // The ids as they were when the dialog opened; later checks change nothing here.
  const opened = useRef<ReadonlyArray<string> | null>(null);
  useEffect(() => {
    if (ids === null) {
      opened.current = null;
      return;
    }
    if (opened.current !== null) return;
    opened.current = ids;
    void startPlanning(ids);
  }, [ids, startPlanning]);

  const plan = planning.result;
  const disrupting = plan?.fixes.filter((f) => f.disrupts !== undefined) ?? [];
  const grouped = useMemo(() => byNode(plan?.fixes ?? []), [plan]);
  const job = applying.result;

  const close = () => {
    setUnderstood(false);
    setJobId(null);
    planning.reset();
    applying.reset();
    onClose();
  };
  const apply = async () => {
    if (plan === null) return;
    const done = await applying.start(plan, understood ? disrupting.map((f) => f.id) : []);
    if (done !== null) onApplied?.();
  };

  return (
    <ActionDialog open={ids !== null} busy={applying.running} onClose={close} className="max-w-2xl">
      {job?.applied != null && plan !== null ? (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>{appliedTitle(job.applied, plan.fixes.length)}</AlertDialogTitle>
            <AlertDialogDescription>The machines were checked again afterwards; the findings are up to date.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-2">
            <AppliedList applied={job.applied} />
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button />}>Done</AlertDialogClose>
          </AlertDialogFooter>
        </>
      ) : (
        <>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {plan === null ? "Apply fixes?" : `Apply ${plural(plan.fixes.length, "fix", "fixes")} on ${plural(machines(plan.fixes), "machine")}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              These are the exact commands. T3 Fleet checks every machine again first and runs only fixes still exactly as shown here, in order per
              machine, machines in parallel. Closing this tab does not stop them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-4">
            {plan === null ? (
              planning.error === null ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Spinner className="size-3.5" />
                  Planning…
                </div>
              ) : null
            ) : (
              <>
                {grouped.map(([node, items]) => (
                  <div key={node} className="flex flex-col gap-2">
                    <div className="font-semibold text-sm">{node}</div>
                    {items.map((f) => (
                      <div key={f.id} className="flex flex-col gap-1.5 border-l-2 pl-3" style={{ borderColor: f.disrupts === undefined ? undefined : "var(--warning)" }}>
                        <div className="text-sm">{f.title}</div>
                        <Code>
                          $ {f.command}
                          {f.on !== undefined && f.on !== f.node ? `\n  (runs on ${f.on})` : ""}
                        </Code>
                        {f.disrupts === undefined ? null : <div className="font-medium text-warning-foreground text-xs">interrupts: {f.disrupts}</div>}
                      </div>
                    ))}
                  </div>
                ))}
                {plan.notApplicable.map((n) => (
                  <div key={n.id} className="text-muted-foreground text-xs">
                    <code>{n.id}</code> will not run: {n.reason}
                  </div>
                ))}
                {disrupting.length > 0 ? (
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2.5 text-warning-foreground text-xs">
                    <input
                      type="checkbox"
                      checked={understood}
                      disabled={applying.running}
                      onChange={(e) => setUnderstood(e.target.checked)}
                      className="mt-0.5 size-3.5 accent-[var(--warning)]"
                    />
                    <span>
                      {disrupting.length === 1 ? "One fix interrupts" : `${disrupting.length} fixes interrupt`} running work, as marked above. Apply anyway.
                    </span>
                  </label>
                ) : null}
              </>
            )}
            <Failure error={planning.error ?? applying.error} />
          </AlertDialogBody>
          <AlertDialogFooter>
            {applying.running && step !== null ? <span className="mr-auto self-center text-muted-foreground text-xs">{step}…</span> : null}
            <AlertDialogClose render={<Button variant="ghost" disabled={applying.running} />}>Cancel</AlertDialogClose>
            <Button
              variant={disrupting.length > 0 ? "destructive" : "default"}
              disabled={applying.running || plan === null || plan.fixes.length === 0 || (disrupting.length > 0 && !understood)}
              onClick={() => void apply()}
            >
              {applying.running ? <Spinner className="size-3.5" /> : <PlayIcon />}
              {applying.running ? "Applying…" : plan === null ? "Apply" : `Apply ${plural(plan.fixes.length, "fix", "fixes")}`}
            </Button>
          </AlertDialogFooter>
        </>
      )}
    </ActionDialog>
  );
}
