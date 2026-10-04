/**
 * Findings by machine and area, and applying their fixes the way `t3-fleet fix`
 * does (see components/fixes.tsx). Notes can have fixes too, as `t3-fleet fix`
 * offers them; they are there to pick, never picked for you.
 */
import type { UiFinding } from "@t3-fleet/core/Api";
import { CheckCircle2Icon, ChevronRightIcon, PlayIcon } from "lucide-react";
import { useId, useState } from "react";

import { CheckButton, CheckedLine, CheckFailed } from "../components/check";
import { Code, ErrorState, LoadingRows, Page, SeverityIcon, worst } from "../components/common";
import { ApplyDialog, byNode, fixable } from "../components/fixes";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group, GroupLabel } from "../components/ui/group";
import { useStore } from "../lib/store";
import { cn, plural } from "../lib/utils";

export function FindingsView() {
  const { status, statusError, recheck } = useStore();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reviewing, setReviewing] = useState<ReadonlyArray<string> | null>(null);

  const findings = status?.findings ?? [];
  const active = findings.filter((f) => f.severity !== "info");
  const accepted = findings.filter((f) => f.accepted !== undefined);
  const notes = findings.filter((f) => f.severity === "info" && f.accepted === undefined);
  const fixes = active.filter(fixable);
  const noteFixes = notes.filter(fixable);
  // A finding can disappear between checks; only what is still there counts.
  const chosen = [...fixes, ...noteFixes].filter((f) => selected.has(f.id));
  const interrupting = chosen.filter((f) => f.fix.disrupts !== undefined).length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Page title="Findings" description={<CheckedLine />} actions={<CheckButton />}>
      <CheckFailed />
      {status === null ? (
        <Group>
          {statusError === null ? (
            <LoadingRows />
          ) : (
            <ErrorState error={statusError} what="the check" onRetry={() => void recheck()} />
          )}
        </Group>
      ) : active.length === 0 ? (
        <Group>
          <Empty icon={<CheckCircle2Icon className="text-success" />} title="Everything matches">
            Every machine runs what it should.{" "}
            {accepted.length + notes.length > 0
              ? `${plural(accepted.length + notes.length, "note")} below.`
              : ""}
          </Empty>
        </Group>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {plural(fixes.length + noteFixes.length, "fix", "fixes")} available
              {noteFixes.length === 0 ? "" : ` (${noteFixes.length} on notes)`} ·{" "}
              {plural(active.length - fixes.length, "finding")} need
              {active.length - fixes.length === 1 ? "s" : ""} a decision
            </span>
            <span className="ml-auto flex gap-1">
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => setSelected(new Set(fixes.map((f) => f.id)))}
                disabled={fixes.length === 0}
              >
                Select all
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() =>
                  setSelected(new Set(fixes.filter((f) => f.fix.safe).map((f) => f.id)))
                }
                disabled={fixes.length === 0}
              >
                Only safe
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() => setSelected(new Set())}
                disabled={selected.size === 0}
              >
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
                  <FindingRow
                    key={f.id}
                    finding={f}
                    selected={selected.has(f.id)}
                    onToggle={() => toggle(f.id)}
                  />
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

      {notes.length > 0 ? <Notes notes={notes} selected={selected} onToggle={toggle} /> : null}

      {chosen.length > 0 ? (
        <div className="sticky bottom-4 z-10 mx-auto flex w-full max-w-lg items-center gap-3 rounded-xl border surface-glass px-4 py-2.5 shadow-lg/10">
          <span className="min-w-0 flex-1 text-sm">
            {plural(chosen.length, "fix", "fixes")} on{" "}
            {plural(new Set(chosen.map((f) => f.fix.on ?? f.node)).size, "machine")}
            {interrupting === 0 ? null : (
              <span className="text-warning-foreground">
                {" "}
                · {interrupting === 1 ? "1 interrupts" : `${interrupting} interrupt`} something
              </span>
            )}
          </span>
          <Button size="sm" onClick={() => setReviewing(chosen.map((f) => f.id))}>
            <PlayIcon />
            Review and apply
          </Button>
        </div>
      ) : null}

      <ApplyDialog
        ids={reviewing}
        onClose={() => setReviewing(null)}
        onApplied={() => setSelected(new Set())}
      />
    </Page>
  );
}

function FindingRow({
  finding: f,
  selected,
  onToggle,
  showNode = false,
}: {
  finding: UiFinding;
  selected: boolean;
  onToggle: () => void;
  showNode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const command = useId();
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
          <span className="min-w-0 flex-1 text-sm leading-5">
            {showNode ? <span className="font-medium">{f.node} </span> : null}
            {f.title}
          </span>
          <Badge variant="outline">{f.area}</Badge>
        </div>
        {f.detail === undefined ? null : (
          <div className="pl-5.5 text-muted-foreground text-xs leading-5">{f.detail}</div>
        )}
        <div className="flex flex-wrap items-center gap-2 pl-5.5 text-xs">
          {f.fix === undefined ? (
            <span className="text-muted-foreground">needs a decision rather than a command</span>
          ) : (
            <>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={command}
                onClick={() => setOpen((o) => !o)}
                className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", open && "rotate-90")}
                />
                fix
              </button>
              {f.fix.disrupts === undefined ? (
                f.fix.safe ? (
                  <Badge variant="success">safe</Badge>
                ) : null
              ) : (
                <Badge variant="warning">interrupts: {f.fix.disrupts}</Badge>
              )}
              {f.fix.on !== undefined && f.fix.on !== f.node ? (
                <span className="text-muted-foreground">runs on {f.fix.on}</span>
              ) : null}
            </>
          )}
          <code className="ml-auto text-2xs text-muted-foreground/70">{f.id}</code>
        </div>
        {open && f.fix !== undefined ? (
          <div id={command}>
            <Code className="ml-5.5">$ {f.fix.command}</Code>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Notes, folded away; one with a fix can be picked here like any other. */
function Notes({
  notes,
  selected,
  onToggle,
}: {
  notes: ReadonlyArray<UiFinding>;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const withFix = notes.filter(fixable).length;
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={list}
        onClick={() => setOpen((o) => !o)}
        className="mb-2 flex cursor-pointer items-center gap-1 px-1 font-medium text-muted-foreground text-xs hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        {plural(notes.length, "note")}
        {withFix === 0 ? null : ` · ${withFix} with a fix`}
      </button>
      {open ? (
        <div id={list}>
          <Group>
            {notes.map((f) =>
              fixable(f) ? (
                <FindingRow
                  key={f.id}
                  finding={f}
                  selected={selected.has(f.id)}
                  onToggle={() => onToggle(f.id)}
                  showNode
                />
              ) : (
                <div key={f.id} className="flex items-start gap-2 px-4 py-2 text-xs">
                  <SeverityIcon severity="info" className="mt-px size-3.5" />
                  <span className="w-24 shrink-0 font-medium">{f.node}</span>
                  <span className="min-w-0 flex-1">
                    {f.title}
                    {f.detail === undefined ? null : (
                      <span className="block text-muted-foreground">{f.detail}</span>
                    )}
                  </span>
                </div>
              ),
            )}
          </Group>
        </div>
      ) : null}
    </section>
  );
}
