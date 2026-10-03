/**
 * Findings by machine and area, and applying their fixes the way `fleetx fix`
 * does: the exact commands first, what each interrupts marked, an explicit
 * confirmation, then results and a fresh check. The server checks again before
 * running anything and skips fixes that no longer apply.
 */
import type { UiFinding } from "@fleetx/core/Api";
import { CheckCircle2Icon, ChevronRightIcon, CircleXIcon, PlayIcon, WrenchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Code, ErrorState, LoadingRows, Page, SeverityIcon, worst } from "../components/common";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group, GroupLabel } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, type UiApplyResultT } from "../lib/api";
import { useStore } from "../lib/store";
import { cn, plural } from "../lib/utils";
import { CheckButton, CheckedLine } from "./Environments";

type Fixable = UiFinding & { readonly fix: NonNullable<UiFinding["fix"]> };
const fixable = (f: UiFinding): f is Fixable => f.fix !== undefined;

const byNode = <T extends { readonly node: string }>(items: ReadonlyArray<T>) => {
  const groups = new Map<string, Array<T>>();
  for (const item of items) groups.set(item.node, [...(groups.get(item.node) ?? []), item]);
  return [...groups.entries()];
};

export function FindingsView() {
  const { status, statusError, recheck } = useStore();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState(false);

  const findings = status?.findings ?? [];
  const active = findings.filter((f) => f.severity !== "info");
  const accepted = findings.filter((f) => f.accepted !== undefined);
  const notes = findings.filter((f) => f.severity === "info" && f.accepted === undefined);
  const fixes = active.filter(fixable);
  // A finding can disappear between checks; only what is still there counts.
  const chosen = fixes.filter((f) => selected.has(f.id));
  const interrupting = chosen.filter((f) => f.fix.disrupts !== undefined).length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Page
      title="Findings"
      description={<CheckedLine />}
      actions={<CheckButton />}
    >
      {status === null ? (
        <Group>{statusError === null ? <LoadingRows /> : <ErrorState error={statusError} what="the check" onRetry={() => void recheck()} />}</Group>
      ) : active.length === 0 ? (
        <Group>
          <Empty icon={<CheckCircle2Icon className="text-success" />} title="Everything matches">
            Every machine runs what it should. {accepted.length + notes.length > 0 ? `${plural(accepted.length + notes.length, "note")} below.` : ""}
          </Empty>
        </Group>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {plural(fixes.length, "fix", "fixes")} available · {plural(active.length - fixes.length, "finding")} need{active.length - fixes.length === 1 ? "s" : ""} a decision
            </span>
            <span className="ml-auto flex gap-1">
              <Button size="xs" variant="ghost-muted" onClick={() => setSelected(new Set(fixes.map((f) => f.id)))} disabled={fixes.length === 0}>
                Select all
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => setSelected(new Set(fixes.filter((f) => f.fix.safe).map((f) => f.id)))}
                disabled={fixes.length === 0}
              >
                Only safe
              </Button>
              <Button size="xs" variant="ghost-muted" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                Clear
              </Button>
            </span>
          </div>
          {byNode(active).map(([node, items]) => (
            <section key={node}>
              <GroupLabel className="flex items-center gap-2">
                <SeverityIcon severity={worst(items.map((f) => f.severity))} className="size-3.5" />
                <span className="font-semibold text-foreground">{node}</span>
                <span>{plural(items.length, "finding")}</span>
              </GroupLabel>
              <Group>
                {items.map((f) => (
                  <FindingRow key={f.id} finding={f} selected={selected.has(f.id)} onToggle={() => toggle(f.id)} />
                ))}
              </Group>
            </section>
          ))}
        </>
      )}

      {accepted.length > 0 ? (
        <section>
          <GroupLabel>Accepted differences</GroupLabel>
          <Group>
            {accepted.map((f) => (
              <div key={f.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <SeverityIcon severity="info" className="size-3.5" />
                  <span className="font-medium">{f.node}</span>
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  <code className="text-2xs text-muted-foreground">{f.id}</code>
                </div>
                <div className="pl-5.5 text-muted-foreground text-xs">accepted: {f.accepted}</div>
              </div>
            ))}
          </Group>
        </section>
      ) : null}

      {notes.length > 0 ? <Notes notes={notes} /> : null}

      {chosen.length > 0 ? (
        <div className="sticky bottom-4 z-10 mx-auto flex w-full max-w-lg items-center gap-3 rounded-xl border surface-glass px-4 py-2.5 shadow-lg/10">
          <span className="min-w-0 flex-1 text-sm">
            {plural(chosen.length, "fix", "fixes")} on {plural(new Set(chosen.map((f) => f.fix.on ?? f.node)).size, "machine")}
            {interrupting === 0 ? null : (
              <span className="text-warning-foreground"> · {interrupting === 1 ? "1 interrupts" : `${interrupting} interrupt`} something</span>
            )}
          </span>
          <Button size="sm" onClick={() => setReviewing(true)}>
            <PlayIcon />
            Review and apply
          </Button>
        </div>
      ) : null}

      <ApplyDialog open={reviewing} fixes={chosen} onClose={() => setReviewing(false)} onApplied={() => setSelected(new Set())} />
    </Page>
  );
}

function FindingRow({ finding: f, selected, onToggle }: { finding: UiFinding; selected: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("flex gap-3 px-4 py-3", selected && "bg-primary/4")}>
      <div className="flex w-4 shrink-0 justify-center pt-0.5">
        {f.fix === undefined ? null : (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Apply the fix for ${f.title}`}
            className="size-3.5 cursor-pointer accent-primary"
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <SeverityIcon severity={f.severity} className="mt-0.5 size-3.5" />
          <span className="min-w-0 flex-1 text-sm leading-5">{f.title}</span>
          <Badge variant="outline">{f.area}</Badge>
        </div>
        {f.detail === undefined ? null : <div className="pl-5.5 text-muted-foreground text-xs leading-5">{f.detail}</div>}
        <div className="flex flex-wrap items-center gap-2 pl-5.5 text-xs">
          {f.fix === undefined ? (
            <span className="text-muted-foreground">needs a decision rather than a command</span>
          ) : (
            <>
              <button type="button" onClick={() => setOpen((o) => !o)} className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
                <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
                fix
              </button>
              {f.fix.disrupts === undefined ? (
                f.fix.safe ? (
                  <Badge variant="success">safe</Badge>
                ) : null
              ) : (
                <Badge variant="warning">interrupts: {f.fix.disrupts}</Badge>
              )}
              {f.fix.on !== undefined && f.fix.on !== f.node ? <span className="text-muted-foreground">runs on {f.fix.on}</span> : null}
            </>
          )}
          <code className="ml-auto text-2xs text-muted-foreground/70">{f.id}</code>
        </div>
        {open && f.fix !== undefined ? <Code className="ml-5.5">$ {f.fix.command}</Code> : null}
      </div>
    </div>
  );
}

function Notes({ notes }: { notes: ReadonlyArray<UiFinding> }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen((o) => !o)} className="mb-2 flex cursor-pointer items-center gap-1 px-1 font-medium text-muted-foreground text-xs hover:text-foreground">
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        {plural(notes.length, "note")}
      </button>
      {open ? (
        <Group>
          {notes.map((f) => (
            <div key={f.id} className="flex items-start gap-2 px-4 py-2 text-xs">
              <SeverityIcon severity="info" className="mt-px size-3.5" />
              <span className="w-24 shrink-0 font-medium">{f.node}</span>
              <span className="min-w-0 flex-1">
                {f.title}
                {f.detail === undefined ? null : <span className="block text-muted-foreground">{f.detail}</span>}
              </span>
            </div>
          ))}
        </Group>
      ) : null}
    </section>
  );
}

function ApplyDialog({
  open,
  fixes,
  onClose,
  onApplied,
}: {
  open: boolean;
  fixes: ReadonlyArray<Fixable>;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { setStatus } = useStore();
  const [understood, setUnderstood] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<UiApplyResultT | null>(null);
  const [error, setError] = useState<unknown>(null);
  const disrupting = fixes.filter((f) => f.fix.disrupts !== undefined);
  const machines = useMemo(() => byNode(fixes), [fixes]);

  const reset = () => {
    setUnderstood(false);
    setResult(null);
    setError(null);
  };

  const apply = async () => {
    setRunning(true);
    setError(null);
    try {
      const outcome = await api.applyFixes(fixes.map((f) => f.id));
      setResult(outcome);
      setStatus(outcome.status);
      onApplied();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !running) {
          onClose();
          reset();
        }
      }}
    >
      <AlertDialogPopup className="max-w-2xl">
        {result === null ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Apply {plural(fixes.length, "fix", "fixes")} on {plural(new Set(fixes.map((f) => f.fix.on ?? f.node)).size, "machine")}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                fleetx checks every machine again first and runs only fixes that still apply, in order per machine, machines in parallel.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody className="flex flex-col gap-4">
              {machines.map(([node, items]) => (
                <div key={node} className="flex flex-col gap-2">
                  <div className="font-semibold text-sm">{node}</div>
                  {items.map((f) => (
                    <div key={f.id} className="flex flex-col gap-1.5 border-l-2 pl-3" style={{ borderColor: f.fix.disrupts === undefined ? undefined : "var(--warning)" }}>
                      <div className="text-sm">{f.title}</div>
                      <Code>
                        $ {f.fix.command}
                        {f.fix.on !== undefined && f.fix.on !== f.node ? `\n  (runs on ${f.fix.on})` : ""}
                      </Code>
                      {f.fix.disrupts === undefined ? null : (
                        <div className="font-medium text-warning-foreground text-xs">interrupts: {f.fix.disrupts}</div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              {disrupting.length > 0 ? (
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2.5 text-warning-foreground text-xs">
                  <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-0.5 size-3.5 accent-[var(--warning)]" />
                  <span>
                    {disrupting.length === 1 ? "One fix interrupts" : `${disrupting.length} fixes interrupt`} running work, as marked above. Apply anyway.
                  </span>
                </label>
              ) : null}
              {error === null ? null : (
                <div className="rounded-lg border border-destructive/30 bg-error-surface px-3 py-2 text-destructive-foreground text-xs">
                  {error instanceof Error ? error.message : String(error)}
                </div>
              )}
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" disabled={running} />}>Cancel</AlertDialogClose>
              <Button
                variant={disrupting.length > 0 ? "destructive" : "default"}
                disabled={running || fixes.length === 0 || (disrupting.length > 0 && !understood)}
                onClick={() => void apply()}
              >
                {running ? <Spinner className="size-3.5" /> : <PlayIcon />}
                {running ? "Applying…" : `Apply ${plural(fixes.length, "fix", "fixes")}`}
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {result.results.every((r) => r.ok) && result.notApplied.length === 0
                  ? `Applied ${plural(result.results.length, "fix", "fixes")}`
                  : `${result.results.filter((r) => r.ok).length} of ${fixes.length} applied`}
              </AlertDialogTitle>
              <AlertDialogDescription>The machines were checked again afterwards; the findings are up to date.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody className="flex flex-col gap-2">
              {result.results.map((r) => (
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
              {result.notApplied.map((n) => (
                <div key={n.id} className="flex items-start gap-2 text-sm">
                  <WrenchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <code className="text-xs">{n.id}</code> <span className="text-muted-foreground text-xs">not applied: {n.reason}</span>
                  </div>
                </div>
              ))}
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button />}>Done</AlertDialogClose>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
