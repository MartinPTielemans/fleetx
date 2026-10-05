/**
 * The plan: everything setup would do, read from this computer, before
 * anything is written. What is added, what conflicts (one at a time, with the
 * diff and the choices), the credentials (names only), the hub's part, and
 * every step apply will run.
 */
import type { UiPlanConflict, UiPlanItem, UiSetupPlan } from "@t3-fleet/core/SetupApi";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileTextIcon,
  FolderGit2Icon,
  KeyRoundIcon,
  LockKeyholeIcon,
  MinusCircleIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { ErrorState } from "../../components/common";
import { Failure } from "../../components/dialogs";
import { Diff } from "../../components/Diff";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { isStalePlan } from "../../lib/api";
import { cn, plural } from "../../lib/utils";
import { inputClass, Prose, StepFrame } from "./parts";
import { choiceOf, conflictNow, openConflicts, settingParts, type Choices } from "./wizard";

const KIND: Readonly<Record<UiPlanItem["kind"], { one: string; many: string; icon: ReactNode }>> = {
  skill: { one: "Skill", many: "Skills", icon: <SparklesIcon /> },
  server: { one: "MCP server", many: "MCP servers", icon: <PlugIcon /> },
  instruction: { one: "Instructions", many: "Instructions", icon: <FileTextIcon /> },
};

/** "https://github.com/o/fleet.git" → "github.com/o/fleet". */
const shortRemote = (url: string) =>
  url
    .replace(/^(?:https?|ssh):\/\/(?:[^@/]+@)?/, "")
    .replace(/^[\w.-]+@([\w.-]+):/, "$1/")
    .replace(/\.git$/, "");

export interface PlanLoad {
  readonly data: UiSetupPlan | null;
  readonly loading: boolean;
  readonly error: unknown;
  /** The plan is the answer to the answers as they are now, made without an error: it may be applied. */
  readonly ready: boolean;
  readonly reload: () => void;
}

export function PlanStep({
  plan: load,
  choices,
  onChoose,
  values,
  onValue,
  later,
  onLater,
  applying,
  applyError,
  onBack,
  onApply,
}: {
  plan: PlanLoad;
  choices: Choices;
  onChoose: (id: string, value: string) => void;
  values: Readonly<Record<string, string>>;
  onValue: (name: string, value: string) => void;
  later: ReadonlySet<string>;
  onLater: (name: string, later: boolean) => void;
  applying: boolean;
  applyError: unknown;
  onBack: () => void;
  onApply: () => void;
}) {
  const plan = load.data;
  // Apply refused the plan as out of date; any other refusal says why in its own words.
  const changed = isStalePlan(applyError);
  return (
    <StepFrame
      width="medium"
      title="Review the plan"
      lead={
        <>
          Everything setup will do, read from this computer just now. Nothing is written until you
          press <span className="font-medium text-foreground">Set up</span>.
        </>
      }
      back={applying ? undefined : onBack}
      hint={plan === null ? (load.loading ? "Making the plan…" : null) : null}
      actions={
        <Button disabled={!load.ready || applying} onClick={onApply}>
          {applying ? <Spinner className="size-3.5" /> : null}
          {plan?.hub == null ? "Set up" : `Set up both machines`}
          {applying ? null : <ArrowRightIcon />}
        </Button>
      }
    >
      {applyError === null ? null : (
        <div className="mb-6 flex flex-col gap-2">
          {changed ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2.5 text-sm"
            >
              <span className="min-w-0 flex-1 text-warning-foreground">
                Something on this computer or in the fleet changed since this plan was made, so it
                wasn't applied. Make it again and review it: your choices stay where they still
                apply.
              </span>
              <Button size="sm" variant="outline" onClick={load.reload}>
                <RefreshCwIcon />
                Make the plan again
              </Button>
            </div>
          ) : (
            <Failure error={applyError} />
          )}
        </div>
      )}
      {plan === null ? (
        load.loading ? (
          <PlanSkeleton />
        ) : (
          <ErrorState error={load.error} what="the plan" onRetry={load.reload} />
        )
      ) : (
        <div
          className={cn(
            "flex flex-col gap-10 transition-opacity duration-200",
            load.loading && "pointer-events-none opacity-50",
          )}
          aria-busy={load.loading}
        >
          <RepoLine plan={plan} />
          <Decide plan={plan} choices={choices} onChoose={onChoose} />
          <Adding items={plan.add} commits={plan.commits} />
          <Credentials
            plan={plan}
            values={values}
            onValue={onValue}
            later={later}
            onLater={onLater}
          />
          <Settings settings={plan.settings} />
          <Collapsed
            title="Already the same"
            note="In the fleet and on this computer alike: nothing to do."
            count={plan.same.length}
          >
            <ul className="flex flex-col">
              {plan.same.map((item) => (
                <ItemRow key={`${item.kind}:${item.name}`} item={item} />
              ))}
            </ul>
          </Collapsed>
          <Collapsed
            title="Left alone"
            note="Found here, but not the fleet's to keep."
            count={plan.leftAlone.length}
          >
            <ul className="flex flex-col">
              {plan.leftAlone.map(({ item, why }) => (
                <ItemRow key={`${item.kind}:${item.name}`} item={{ ...item, note: why }} neutral />
              ))}
            </ul>
          </Collapsed>
          <Steps plan={plan} />
        </div>
      )}
    </StepFrame>
  );
}

function PlanSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy>
      <div className="flex items-center gap-3 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Looking at this computer's skills, MCP servers and instructions…
      </div>
      {[5, 3, 4].map((rows, s) => (
        <div key={s} className="flex flex-col gap-3">
          <Skeleton className="h-3 w-28" />
          <div className="flex flex-col gap-3.5 rounded-xl border bg-card/40 p-4">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-3" style={{ width: `${24 + ((i * 23 + s * 11) % 40)}%` }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Section({
  id,
  title,
  count,
  note,
  aside,
  children,
}: {
  id?: string;
  title: ReactNode;
  count?: number;
  note?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={typeof title === "string" ? title : undefined}
      className="flex flex-col gap-3"
    >
      <div className="flex items-end gap-3 px-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="flex items-baseline gap-2 font-semibold text-sm">
            {title}
            {count === undefined ? null : (
              <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
            )}
          </h2>
          {note === undefined ? null : (
            <p className="text-pretty text-muted-foreground text-xs leading-5">{note}</p>
          )}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const card = "overflow-hidden rounded-xl border bg-card/50 shadow-xs/5";

function RepoLine({ plan }: { plan: UiSetupPlan }) {
  const mode =
    plan.mode === "first"
      ? "A new fleet"
      : plan.mode === "join"
        ? "Joining a fleet"
        : "This computer, set up again";
  return (
    <div className={cn(card, "flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3")}>
      <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 basis-60 flex-col">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-mono">{plan.repo.path}</span>
          {plan.repo.remote === null ? (
            <span className="text-muted-foreground text-xs">no remote yet</span>
          ) : (
            <>
              <span aria-hidden className="text-muted-foreground">
                →
              </span>
              <span className="truncate font-mono">{shortRemote(plan.repo.remote)}</span>
            </>
          )}
        </div>
        <div className="text-muted-foreground text-xs">
          {mode} ·{" "}
          {plan.commits
            ? `${plan.node} commits its changes: it's the authority.`
            : `${plan.node} proposes its changes; the fleet's authority approves them.`}
        </div>
      </div>
    </div>
  );
}

// ── conflicts, one at a time ────────────────────────────────────────────

function Decide({
  plan,
  choices,
  onChoose,
}: {
  plan: UiSetupPlan;
  choices: Choices;
  onChoose: (id: string, value: string) => void;
}) {
  const open = openConflicts(plan, choices);
  const [at, setAt] = useState(0);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  if (open.length === 0) return null;
  const index = Math.min(at, open.length - 1);
  const conflict = open[index] as UiPlanConflict;
  const go = (i: number) => {
    setSeen((s) => new Set(s).add(conflict.id));
    setAt(i);
  };
  const detail = conflictNow(conflict, choices, plan.conflicts).detail;
  const picked = choiceOf(conflict, choices);
  return (
    <Section
      id="plan-decide"
      title="Decide"
      count={open.length}
      note="Where this computer has two versions of something, or differs from the fleet. Each starts on its default; change it if you know better."
    >
      <div className={cn(card, "bg-card")}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
          <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-accent px-1.5 font-medium text-2xs text-muted-foreground [&_svg]:size-3">
            {KIND[conflict.kind].icon}
            {KIND[conflict.kind].one}
          </span>
          <h3 className="min-w-0 flex-1 basis-48 font-medium text-sm">{conflict.title}</h3>
          {open.length > 1 ? (
            <div className="flex items-center gap-1">
              <span className="mr-1 text-muted-foreground text-xs tabular-nums" aria-live="polite">
                {index + 1} of {open.length}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Previous conflict"
                disabled={index === 0}
                onClick={() => go(index - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Next conflict"
                disabled={index === open.length - 1}
                onClick={() => go(index + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          ) : null}
        </header>
        <div key={conflict.id} className="motion-safe:animate-enter motion-reduce:animate-fade-in">
          <div className="border-b [&>div]:max-h-80">
            <Diff text={detail} />
          </div>
          <fieldset className="flex flex-col gap-1 p-2">
            <legend className="sr-only">What to do about {conflict.name}</legend>
            {conflict.choices.map((c) => (
              <label
                key={c.value}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 has-focus-visible:ring-2 has-focus-visible:ring-ring",
                  picked === c.value ? "bg-primary/6 dark:bg-primary/12" : "hover:bg-accent/60",
                )}
              >
                <input
                  type="radio"
                  name={`conflict-${conflict.id}`}
                  value={c.value}
                  checked={picked === c.value}
                  onChange={() => onChoose(conflict.id, c.value)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 rounded-full border bg-background transition-[border-width,border-color] duration-150",
                    picked === c.value ? "border-[5px] border-primary" : "border-input",
                  )}
                />
                <span className="min-w-0 flex-1 first-letter:uppercase">{c.label}</span>
                {c.value === conflict.default ? (
                  <span className="text-muted-foreground text-xs">default</span>
                ) : null}
              </label>
            ))}
          </fieldset>
        </div>
        {open.length > 1 ? (
          <footer className="flex items-center gap-1.5 border-t bg-muted/40 px-4 py-2.5">
            {open.map((c, i) => (
              <button
                key={c.id}
                type="button"
                aria-label={`Conflict ${i + 1}: ${c.title}`}
                aria-current={i === index ? "true" : undefined}
                onClick={() => go(i)}
                className={cn(
                  "h-1.5 cursor-pointer rounded-full transition-[width,background-color] duration-200 ease-(--ease-out-strong)",
                  i === index
                    ? "w-5 bg-primary"
                    : seen.has(c.id) || choices[c.id] !== undefined
                      ? "w-1.5 bg-primary/40"
                      : "w-1.5 bg-muted-foreground/25 hover:bg-muted-foreground/45",
                )}
              />
            ))}
            {index < open.length - 1 ? (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => go(index + 1)}>
                Next: {open[index + 1]?.name}
                <ChevronRightIcon />
              </Button>
            ) : null}
          </footer>
        ) : null}
      </div>
    </Section>
  );
}

// ── items ───────────────────────────────────────────────────────────────

/**
 * One item. `neutral` leaves its kind unsaid: what is left alone includes
 * things that are not skills, servers or instructions (agent CLIs come as
 * servers for now), so there only the name, where it is and why speak.
 */
function ItemRow({ item, neutral = false }: { item: UiPlanItem; neutral?: boolean }) {
  return (
    <li className="flex items-start gap-3 px-4 py-2">
      {neutral ? (
        <MinusCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
      ) : (
        <span
          aria-label={KIND[item.kind].one}
          className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4"
        >
          {KIND[item.kind].icon}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-sm">{item.name}</span>
          <span className="truncate font-mono text-2xs text-muted-foreground">{item.from}</span>
        </div>
        {item.note === null ? null : (
          <span className="text-pretty text-muted-foreground text-xs leading-5">{item.note}</span>
        )}
      </div>
    </li>
  );
}

const FIRST = 6;

function Adding({ items, commits }: { items: ReadonlyArray<UiPlanItem>; commits: boolean }) {
  if (items.length === 0) return null;
  const kinds = (["skill", "server", "instruction"] as const)
    .map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) }))
    .filter((g) => g.items.length > 0);
  return (
    <Section
      id="plan-add"
      title={commits ? "Adding to the fleet" : "Proposing to the fleet"}
      count={items.length}
      note={
        commits
          ? "From this computer into the repository, for every machine."
          : "From this computer; the fleet's authority approves them."
      }
    >
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]">
        {kinds.map((g) => (
          <KindGroup key={g.kind} kind={g.kind} items={g.items} />
        ))}
      </div>
    </Section>
  );
}

function KindGroup({
  kind,
  items,
}: {
  kind: UiPlanItem["kind"];
  items: ReadonlyArray<UiPlanItem>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <div className={cn(card, "flex flex-col")}>
      <div className="flex items-center gap-2 border-b px-4 py-2.5 font-medium text-xs [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        {KIND[kind].icon}
        {KIND[kind].many}
        <span className="ml-auto font-normal text-muted-foreground tabular-nums">
          {items.length}
        </span>
      </div>
      <ul className="flex flex-col py-1">
        {shown.map((item) => (
          <li key={item.name} className="flex min-w-0 flex-col px-4 py-1.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm">{item.name}</span>
              <span className="ml-auto shrink-0 truncate font-mono text-2xs text-muted-foreground">
                {item.from}
              </span>
            </div>
            {item.note === null ? null : (
              <span className="text-pretty text-muted-foreground text-xs leading-5">
                {item.note}
              </span>
            )}
          </li>
        ))}
      </ul>
      {items.length > FIRST ? (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          aria-expanded={all}
          className="mt-auto flex cursor-pointer items-center gap-1 border-t px-4 py-2 text-left text-muted-foreground text-xs outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {all ? "Show fewer" : `Show ${items.length - FIRST} more`}
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform duration-200", all && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}

function Collapsed({
  title,
  note,
  count,
  children,
}: {
  title: string;
  note: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <section aria-label={title} className={card}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2 font-semibold text-sm">
            {title}
            <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
          </span>
          <span className="text-muted-foreground text-xs">{note}</span>
        </div>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-(--ease-out-strong)",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="border-t py-1 motion-safe:animate-enter motion-reduce:animate-fade-in">
          {children}
        </div>
      ) : null}
    </section>
  );
}

// ── credentials ─────────────────────────────────────────────────────────

function Credentials({
  plan,
  values,
  onValue,
  later,
  onLater,
}: {
  plan: UiSetupPlan;
  values: Readonly<Record<string, string>>;
  onValue: (name: string, value: string) => void;
  later: ReadonlySet<string>;
  onLater: (name: string, later: boolean) => void;
}) {
  if (plan.secrets.length === 0 && plan.missing.length === 0) return null;
  return (
    <Section
      id="plan-credentials"
      title="Credentials"
      count={plan.secrets.length + plan.missing.length}
      note="They go into the fleet's encrypted secrets file, which only your machines can open. Only names are shown here."
    >
      {plan.secrets.length === 0 ? null : (
        <ul className={cn(card, "flex flex-col py-1")}>
          {plan.secrets.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2">
              <LockKeyholeIcon className="size-3.5 shrink-0 text-success" aria-label="found" />
              <span className="font-mono text-xs">{s.name}</span>
              <span className="text-muted-foreground text-xs">for {s.server}</span>
              <span className="ml-auto text-muted-foreground text-xs">from {s.from}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.missing.length === 0 ? null : (
        <div className={cn(card, "flex flex-col")}>
          <div className="flex items-center gap-2 border-b bg-warning-surface px-4 py-2.5 text-warning-foreground text-xs">
            <KeyRoundIcon className="size-3.5 shrink-0" />
            {plan.missing.length === 1
              ? "One wasn't found on this computer. Type it in, or set it later."
              : `${plan.missing.length} weren't found on this computer. Type them in, or set them later.`}
          </div>
          <ul className="flex flex-col divide-y">
            {plan.missing.map((m) => (
              <Missing
                key={m.name}
                name={m.name}
                why={m.why}
                value={values[m.name] ?? ""}
                onValue={(v) => onValue(m.name, v)}
                later={later.has(m.name)}
                onLater={(l) => onLater(m.name, l)}
              />
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Missing({
  name,
  why,
  value,
  onValue,
  later,
  onLater,
}: {
  name: string;
  why: string;
  value: string;
  onValue: (value: string) => void;
  later: boolean;
  onLater: (later: boolean) => void;
}) {
  const [shown, setShown] = useState(false);
  const id = `secret-${name}`;
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-col">
        <label htmlFor={id} className="font-mono text-xs">
          {name}
        </label>
        <span className="text-muted-foreground text-xs leading-5">{why}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <input
            id={id}
            type={shown ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            disabled={later}
            placeholder={later ? "Set later" : "Paste the value"}
            value={later ? "" : value}
            onChange={(e) => onValue(e.currentTarget.value)}
            className={cn(inputClass, "pr-9 font-mono")}
          />
          <Button
            size="icon-xs"
            variant="ghost"
            className="absolute top-1 right-1"
            aria-label={shown ? "Hide value" : "Show value"}
            aria-pressed={shown}
            disabled={later}
            onClick={() => setShown((s) => !s)}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs has-focus-visible:rounded-sm has-focus-visible:ring-2 has-focus-visible:ring-ring">
          <input
            type="checkbox"
            checked={later}
            onChange={(e) => onLater(e.currentTarget.checked)}
            className="size-3.5 cursor-pointer accent-(--primary)"
          />
          Set later
        </label>
      </div>
    </li>
  );
}

// ── settings ────────────────────────────────────────────────────────────

function Settings({ settings }: { settings: ReadonlyArray<string> }) {
  if (settings.length === 0) return null;
  return (
    <Section
      id="plan-settings"
      title="Looking after your machines"
      note="What you chose earlier, as it goes into the fleet's settings."
    >
      <ul className={cn(card, "flex flex-col py-1.5")}>
        {settings.map((line) => {
          const { text, where } = settingParts(line);
          return (
            <li key={line} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-1.5">
              <SlidersHorizontalIcon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 basis-56 text-pretty text-sm leading-5">
                <Prose text={text} />
              </span>
              {where === null ? null : (
                <code className="font-mono text-2xs text-muted-foreground">{where}</code>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ── the steps ───────────────────────────────────────────────────────────

function Steps({ plan }: { plan: UiSetupPlan }) {
  return (
    <Section
      id="plan-steps"
      title="What setup will run"
      note="In this order. Each step is recorded as it finishes, so a run that stops can continue where it left off."
    >
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(17rem,1fr))]">
        <StepList title={`On this computer · ${plan.node}`} steps={plan.steps} />
        {plan.hub === null ? null : (
          <StepList
            title={`On the hub · ${plan.hub.node}`}
            sub={plan.hub.relayUrl ?? plan.hub.ssh}
            icon={<ServerIcon />}
            steps={plan.hub.steps}
          />
        )}
      </div>
    </Section>
  );
}

function StepList({
  title,
  sub,
  icon,
  steps,
}: {
  title: string;
  sub?: string;
  icon?: ReactNode;
  steps: ReadonlyArray<string>;
}) {
  return (
    <div className={cn(card, "flex flex-col")}>
      <div className="flex items-center gap-2 border-b px-4 py-2.5 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        {icon}
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-xs">{title}</span>
          {sub === undefined ? null : (
            <span className="truncate font-mono text-2xs text-muted-foreground">{sub}</span>
          )}
        </div>
        <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground text-xs tabular-nums">
          {plural(steps.length, "step")}
        </span>
      </div>
      <ol className="flex flex-col py-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-baseline gap-3 px-4 py-1">
            <span className="w-4 shrink-0 text-right text-2xs text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <span className="text-pretty text-sm leading-5">
              <Prose text={s} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
