/** The wizard's frame and the controls its steps share: the step rail, a step's page, choices, fields, a command to copy. */
import { ArrowLeftIcon, BoxesIcon, CheckIcon, CopyIcon } from "lucide-react";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { STEP_LABEL, type StepId } from "./wizard";

export const inputClass =
  "h-8 w-full min-w-0 rounded-[var(--control-radius)] border border-input bg-popover px-2.5 text-sm shadow-xs/5 outline-none transition-[box-shadow,border-color] placeholder:text-muted-foreground/60 focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive/60 disabled:opacity-64 dark:bg-input/32";

// ── the rail ────────────────────────────────────────────────────────────

export interface RailStep {
  readonly id: StepId;
  /** What was decided there, once it was. */
  readonly summary: string | null;
  /** Whether going back to it is allowed. */
  readonly reachable: boolean;
}

/** The steps down the left, where the app's views will be: each with what was chosen there. */
export function StepRail({
  steps,
  current,
  onGo,
  footer,
}: {
  steps: ReadonlyArray<RailStep>;
  current: StepId;
  onGo: (step: StepId) => void;
  footer?: ReactNode;
}) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <aside className="hidden w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-13 items-center gap-2 px-4">
        <BoxesIcon className="size-4.5 text-primary" />
        <span className="font-semibold text-sm tracking-tight">T3 Fleet</span>
        <span className="ml-auto text-2xs text-sidebar-muted-foreground">setup</span>
      </div>
      <nav aria-label="Setup steps" className="px-2 py-2">
        <ol className="flex flex-col">
          {steps.map((step, i) => {
            const state = i < at ? "done" : i === at ? "current" : "next";
            const go = step.reachable && state !== "current";
            const inner = (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "relative z-10 mt-px flex size-5 shrink-0 items-center justify-center rounded-full border font-medium text-2xs tabular-nums transition-[background-color,border-color,color] duration-200",
                    state === "current" &&
                      "border-primary bg-primary text-primary-foreground shadow-primary/30 shadow-sm",
                    state === "done" && "border-primary/25 bg-primary/10 text-primary",
                    state === "next" && "border-border bg-sidebar text-sidebar-muted-foreground",
                  )}
                >
                  {state === "done" ? <CheckIcon className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      "font-medium text-sm leading-5",
                      state === "next" && "text-sidebar-muted-foreground/80",
                    )}
                  >
                    {STEP_LABEL[step.id]}
                  </span>
                  {step.summary === null || state === "next" ? null : (
                    <span className="truncate text-2xs text-sidebar-muted-foreground leading-4">
                      {step.summary}
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <li
                key={step.id}
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "relative",
                  // The line from this step's mark down to the next one's.
                  i < steps.length - 1 &&
                    "after:absolute after:top-6 after:bottom-[-0.375rem] after:left-[1.5625rem] after:w-px after:bg-border",
                  i < at && "after:bg-primary/30",
                )}
              >
                {go ? (
                  <button
                    type="button"
                    onClick={() => onGo(step.id)}
                    className="flex w-full cursor-pointer items-start gap-2.5 rounded-[var(--control-radius)] px-2.5 py-2 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {inner}
                  </button>
                ) : (
                  <div
                    className={cn(
                      "flex items-start gap-2.5 rounded-[var(--control-radius)] px-2.5 py-2",
                      state === "current" && "bg-sidebar-row-selected shadow-xs/5",
                    )}
                  >
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {footer === undefined ? null : (
        <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border/70 px-3 py-3">
          {footer}
        </div>
      )}
    </aside>
  );
}

/** The rail's narrow-window form: where you are, and how far there is to go. */
export function StepBar({ steps, current }: { steps: ReadonlyArray<RailStep>; current: StepId }) {
  const at = steps.findIndex((s) => s.id === current);
  return (
    <div className="shrink-0 border-b bg-sidebar px-4 pt-2.5 pb-3 md:hidden">
      <div className="flex items-center gap-2 text-xs">
        <BoxesIcon className="size-4 text-primary" />
        <span className="font-semibold tracking-tight">T3 Fleet</span>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {at + 1} of {steps.length} ·{" "}
          <span className="text-foreground">{STEP_LABEL[current]}</span>
        </span>
      </div>
      <div className="mt-2.5 flex gap-1" aria-hidden>
        {steps.map((s, i) => (
          <span
            key={s.id}
            className={cn(
              "h-1 flex-1 rounded-full bg-accent transition-colors duration-300",
              i <= at && "bg-primary",
              i === at && "bg-primary/60",
            )}
          />
        ))}
      </div>
    </div>
  );
}

// ── a step's page ───────────────────────────────────────────────────────

const WIDTH = { narrow: "max-w-2xl", medium: "max-w-3xl", wide: "max-w-5xl" } as const;

/**
 * One step: a heading that takes focus when the step opens (so a screen
 * reader says where it is), the content, and a footer that stays in reach.
 */
export function StepFrame({
  title,
  lead,
  width = "narrow",
  back,
  hint,
  actions,
  children,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /** narrow for questions, medium for the plan, wide for two columns. */
  width?: "narrow" | "medium" | "wide";
  back?: (() => void) | undefined;
  /** Why the main action waits, said next to it. */
  hint?: string | null | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex flex-col px-5 pt-8 pb-12 motion-safe:animate-enter motion-reduce:animate-fade-in sm:px-8 sm:pt-12",
            WIDTH[width],
          )}
        >
          <header className="mb-8 flex max-w-[62ch] flex-col gap-2">
            <h1
              ref={heading}
              tabIndex={-1}
              className="text-balance font-semibold text-[1.375rem] leading-7 tracking-[-0.015em] outline-none sm:text-2xl sm:leading-8"
            >
              {title}
            </h1>
            {lead === undefined ? null : (
              <p className="text-pretty text-muted-foreground text-sm leading-6">{lead}</p>
            )}
          </header>
          {children}
        </div>
      </div>
      {actions === undefined && back === undefined ? null : (
        <footer className="surface-glass shrink-0 border-t">
          <div
            className={cn(
              "mx-auto flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 sm:px-8",
              WIDTH[width],
            )}
          >
            {back === undefined ? null : (
              <Button variant="ghost-muted" onClick={back} className="-ml-2">
                <ArrowLeftIcon />
                Back
              </Button>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-3">
              {hint === null || hint === undefined ? null : (
                <span
                  aria-live="polite"
                  className="hidden truncate text-muted-foreground text-xs sm:block"
                >
                  {hint}
                </span>
              )}
              {actions}
            </div>
            {hint === null || hint === undefined ? null : (
              <span className="w-full text-right text-muted-foreground text-xs sm:hidden">
                {hint}
              </span>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

/** A question on a step: what is asked, a line of help, the control. */
export function Question({
  title,
  help,
  children,
  id,
}: {
  title: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const own = useId();
  const labelId = id ?? own;
  return (
    <section aria-labelledby={labelId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={labelId} className="font-medium text-sm">
          {title}
        </h2>
        {help === undefined ? null : (
          <p className="text-pretty text-muted-foreground text-xs leading-5">{help}</p>
        )}
      </div>
      {children}
    </section>
  );
}

// ── choices ─────────────────────────────────────────────────────────────

/**
 * One of a set of choices, as a card: a native radio underneath, so arrows,
 * Space and screen readers work as they do anywhere. What only matters once
 * it is chosen (a name, a URL) opens below.
 */
export function ChoiceCard({
  name,
  value,
  checked,
  onChange,
  icon,
  title,
  description,
  disabled = false,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card/50 shadow-xs/5 transition-[border-color,background-color,box-shadow] duration-200",
        checked
          ? "border-primary/45 bg-primary/[0.035] shadow-primary/10 dark:bg-primary/[0.06]"
          : "hover:border-input",
        disabled && "opacity-64",
      )}
    >
      <label
        className={cn(
          "flex items-start gap-3 rounded-xl p-3.5 has-focus-visible:ring-2 has-focus-visible:ring-ring",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => onChange(value)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs/5 transition-colors duration-200 [&_svg]:size-4",
            checked ? "border-primary/30 text-primary" : "text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-sm">{title}</span>
          <span className="text-pretty text-muted-foreground text-xs leading-5">{description}</span>
        </span>
        <span
          aria-hidden
          className={cn(
            "mt-1 size-4 shrink-0 rounded-full border bg-background transition-[border-width,border-color] duration-150",
            checked ? "border-[5px] border-primary" : "border-input",
          )}
        />
      </label>
      {checked && children !== undefined ? (
        <div className="px-3.5 pb-3.5 pl-[3.625rem] motion-safe:animate-enter motion-reduce:animate-fade-in">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A checkbox row: native underneath, a T3 switch on top. What only matters once it is on opens below. */
export function Toggle({
  checked,
  onChange,
  title,
  description,
  disabled = false,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const row = (
    <label
      className={cn(
        "flex items-start gap-3 px-4 py-3 has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", disabled && "opacity-64")}>
        <span className="font-medium text-sm">{title}</span>
        <span className="text-pretty text-muted-foreground text-xs leading-5">{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "relative mt-0.5 h-5 w-8.5 shrink-0 rounded-full transition-colors duration-200",
          checked ? "bg-primary" : "bg-input dark:bg-white/12",
          disabled && "opacity-48",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-(--ease-out-strong)",
            checked && "translate-x-3.5",
          )}
        />
      </span>
    </label>
  );
  if (children === undefined) return row;
  return (
    <div>
      {row}
      {checked ? (
        <div className="px-4 pb-3.5 motion-safe:animate-enter motion-reduce:animate-fade-in">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A labelled text field with its problem, said once the user has typed. */
export function Field({
  label,
  hint,
  problem,
  prefix,
  className,
  ...input
}: {
  label: ReactNode;
  hint?: ReactNode;
  problem?: string | null;
  prefix?: ReactNode;
  className?: string;
} & Omit<ComponentProps<"input">, "prefix">) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const shown = touched && problem !== null && problem !== undefined ? problem : null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="font-medium text-xs">
        {label}
      </label>
      <div className="flex min-w-0 items-center">
        {prefix === undefined ? null : (
          <span className="flex h-8 shrink-0 items-center rounded-l-[var(--control-radius)] border border-input border-r-0 bg-muted px-2.5 text-muted-foreground text-sm">
            {prefix}
          </span>
        )}
        <input
          id={id}
          aria-invalid={shown !== null}
          aria-describedby={`${id}-note`}
          autoComplete="off"
          spellCheck={false}
          {...input}
          onBlur={(e) => {
            setTouched(true);
            input.onBlur?.(e);
          }}
          onChange={(e) => {
            if (e.currentTarget.value !== "") setTouched(true);
            input.onChange?.(e);
          }}
          className={cn(inputClass, prefix !== undefined && "rounded-l-none")}
        />
      </div>
      <span
        id={`${id}-note`}
        className={cn(
          "text-xs leading-5",
          shown === null ? "text-muted-foreground" : "text-destructive-foreground",
        )}
      >
        {shown ?? hint}
      </span>
    </div>
  );
}

// ── a command to copy ───────────────────────────────────────────────────

export function CopyCommand({
  command,
  className,
  prompt = true,
  label = "Copy command",
}: {
  command: string;
  className?: string;
  /** The "$" before it; off for what is not a command (a URL). */
  prompt?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      // No clipboard here: select it, so Cmd-C does it.
      const selection = window.getSelection();
      const node = document.getElementById(`cmd-${command.length}`);
      if (selection !== null && node !== null) selection.selectAllChildren(node);
    }
  };
  return (
    <div
      className={cn(
        "group flex min-w-0 items-start gap-2 rounded-lg border bg-code py-1.5 pr-1.5 pl-3",
        className,
      )}
    >
      <code
        id={`cmd-${command.length}`}
        className="min-w-0 flex-1 select-all whitespace-pre-wrap py-0.5 [overflow-wrap:anywhere] font-mono text-code-foreground text-xs leading-5"
      >
        {prompt ? (
          <span aria-hidden className="mr-2 select-none text-muted-foreground/60">
            $
          </span>
        ) : null}
        {command}
      </code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={copied ? "Copied" : label}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
        className="relative shrink-0"
      >
        <CopyIcon
          className={cn(
            "absolute transition-[opacity,scale,filter] duration-200",
            copied ? "scale-75 opacity-0 blur-[2px]" : "opacity-100",
          )}
        />
        <CheckIcon
          className={cn(
            "absolute text-success transition-[opacity,scale,filter] duration-200",
            copied ? "opacity-100" : "scale-75 opacity-0 blur-[2px]",
          )}
        />
      </Button>
    </div>
  );
}

/** Whether a remedy is a command to run rather than a sentence to read. */
export const isCommand = (text: string) =>
  /^(?:sudo |curl |brew |apt|dnf |npm |pnpm |npx |gh |ssh|systemctl |loginctl |tailscale |docker |t3-fleet |export |mkdir |echo |cat |[a-z0-9_.-]+ -)/.test(
    text.trim(),
  ) && !/[.!]\s*$/.test(text.trim());

/**
 * A line the engine wrote, as a sentence here: its first letter capital, and
 * `backticked` parts set as code.
 */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        /^`[^`]+`$/.test(part) ? (
          <code key={i} className="rounded-sm bg-accent px-1 py-px font-mono text-[0.9em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>
            {i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part}
          </Fragment>
        ),
      )}
    </>
  );
}
