/** The first step: this computer, whether there is an always-on machine, how many others; the layout that makes, as they answer. */
import type { UiSetupCheck, UiSetupState } from "@t3-fleet/core/SetupApi";
import {
  ArrowRightIcon,
  LaptopIcon,
  MinusIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";

import { SeverityIcon } from "../../components/common";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { FleetSketch } from "./FleetSketch";
import { ChoiceCard, CopyCommand, Field, isCommand, Prose, Question, StepFrame } from "./parts";
import { nodeNameProblem, type Answers } from "./wizard";

export function MachinesStep({
  state,
  answers,
  set,
  hint,
  onNext,
  onRecheck,
  rechecking,
}: {
  state: UiSetupState;
  answers: Answers;
  set: (patch: Partial<Answers>) => void;
  hint: string | null;
  onNext: () => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <StepFrame
      width="wide"
      title="Set up T3 Fleet"
      lead={
        <>
          T3 Fleet keeps every machine you run T3 Code on the same: skills, MCP servers,
          instructions and provider logins. Say what you have and it suggests a layout. Nothing on
          this computer changes until you've reviewed the plan.
        </>
      }
      hint={hint}
      actions={
        <Button disabled={hint !== null} onClick={onNext}>
          Continue
          <ArrowRightIcon />
        </Button>
      }
    >
      <form
        className="grid gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1fr)_21rem]"
        onSubmit={(e) => {
          e.preventDefault();
          if (hint === null) onNext();
        }}
      >
        <div className="flex min-w-0 flex-col gap-9">
          <ThisComputer
            state={state}
            answers={answers}
            set={set}
            onRecheck={onRecheck}
            rechecking={rechecking}
          />

          <Question
            title="Is one of your machines always on?"
            help="A home server, a Mac mini, a VPS: something that doesn't go to sleep."
          >
            <div role="radiogroup" className="grid gap-2.5 sm:grid-cols-2">
              <ChoiceCard
                name="always-on"
                value="yes"
                checked={answers.alwaysOn === true}
                onChange={() => set({ alwaysOn: true })}
                icon={<ServerIcon />}
                title="Yes"
                description="It becomes the hub: it runs things for the fleet."
              />
              <ChoiceCard
                name="always-on"
                value="no"
                checked={answers.alwaysOn === false}
                onChange={() => set({ alwaysOn: false, hubSkipped: false })}
                icon={<MoonIcon />}
                title="Not yet"
                description="Only laptops and desktops that sleep. A hub can come later."
              />
            </div>
          </Question>

          <Question
            title={
              answers.alwaysOn === true
                ? "Any other machines?"
                : "Other machines you run T3 Code on"
            }
            help={
              answers.alwaysOn === true
                ? "Besides this computer and the always-on one. Each joins afterwards with one command."
                : "Besides this computer. Each joins afterwards with one command."
            }
          >
            <Counter value={answers.others} onChange={(others) => set({ others })} />
          </Question>
        </div>

        <div className="lg:sticky lg:top-0 lg:self-start">
          <FleetSketch node={answers.node} alwaysOn={answers.alwaysOn} others={answers.others} />
        </div>
        <button type="submit" hidden />
      </form>
    </StepFrame>
  );
}

function ThisComputer({
  state,
  answers,
  set,
  onRecheck,
  rechecking,
}: {
  state: UiSetupState;
  answers: Answers;
  set: (patch: Partial<Answers>) => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const problems = state.checks.filter((c) => c.severity === "error" || c.severity === "warn");
  const fine = state.checks.filter((c) => c.severity === "ok" || c.severity === "info");
  const errors = problems.some((c) => c.severity === "error");
  return (
    <section
      aria-label="This computer"
      className="overflow-hidden rounded-xl border bg-card/50 shadow-xs/5"
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/8 text-primary dark:bg-primary/16">
            <LaptopIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="font-medium text-sm">This computer</div>
            <div className="truncate font-mono text-muted-foreground text-xs">{state.hostname}</div>
          </div>
        </div>
        <Field
          className="grow basis-56 sm:grow-0"
          label="Its name in the fleet"
          value={answers.node}
          onChange={(e) => set({ node: e.currentTarget.value })}
          problem={nodeNameProblem(answers.node)}
          hint="What the other machines and the repo call it."
          maxLength={63}
        />
      </div>
      <div className="flex flex-col gap-3 border-t bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-muted-foreground text-xs">
            {errors ? "Before setup can start" : "Ready for setup"}
          </h3>
          <Button
            size="xs"
            variant="ghost-muted"
            className="ml-auto"
            disabled={rechecking}
            onClick={onRecheck}
          >
            {rechecking ? <Spinner className="size-3" /> : <RefreshCwIcon />}
            Check again
          </Button>
        </div>
        {problems.length === 0 ? null : (
          <ul className="flex flex-col gap-2">
            {problems.map((c) => (
              <Problem key={c.key} check={c} />
            ))}
          </ul>
        )}
        {fine.length === 0 ? null : (
          <ul aria-label="Checks that passed" className="flex flex-wrap gap-1.5">
            {fine.map((c) => (
              <li
                key={c.key}
                title={c.detail ?? undefined}
                className="inline-flex h-6 items-center gap-1.5 rounded-full border bg-background px-2 text-xs dark:bg-input/32"
              >
                <SeverityIcon severity={c.severity} className="size-3.5" />
                {c.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Problem({ check }: { check: UiSetupCheck }) {
  const error = check.severity === "error";
  return (
    <li
      role={error ? "alert" : undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
        error ? "border-destructive/25 bg-error-surface" : "border-warning/25 bg-warning-surface",
      )}
    >
      <SeverityIcon severity={check.severity} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div
          className={cn(
            "font-medium text-sm",
            error ? "text-destructive-foreground" : "text-warning-foreground",
          )}
        >
          {check.title}
        </div>
        {check.detail === null ? null : isCommand(check.detail) ? (
          <CopyCommand command={check.detail} className="bg-background/70" />
        ) : (
          <p className="text-pretty text-foreground/80 text-xs leading-5">
            <Prose text={check.detail} />
          </p>
        )}
      </div>
    </li>
  );
}

function Counter({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const clamp = (n: number) => Math.max(0, Math.min(20, Number.isFinite(n) ? Math.round(n) : 0));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="inline-flex h-8 items-center rounded-[var(--control-radius)] border border-input bg-popover shadow-xs/5 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/40 dark:bg-input/32">
        <button
          type="button"
          aria-label="One fewer"
          disabled={value === 0}
          onClick={() => onChange(clamp(value - 1))}
          className="flex h-full w-8 cursor-pointer items-center justify-center rounded-l-[var(--control-radius)] text-muted-foreground outline-none hover:bg-accent hover:text-foreground active:scale-95 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-3.5"
        >
          <MinusIcon />
        </button>
        <input
          type="number"
          inputMode="numeric"
          aria-label="Other machines"
          min={0}
          max={20}
          value={value}
          onChange={(e) => onChange(clamp(e.currentTarget.valueAsNumber))}
          className="h-full w-10 border-x border-input bg-transparent text-center font-medium text-sm tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button
          type="button"
          aria-label="One more"
          disabled={value === 20}
          onClick={() => onChange(clamp(value + 1))}
          className="flex h-full w-8 cursor-pointer items-center justify-center rounded-r-[var(--control-radius)] text-muted-foreground outline-none hover:bg-accent hover:text-foreground active:scale-95 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-3.5"
        >
          <PlusIcon />
        </button>
      </div>
      <span className="text-muted-foreground text-xs">
        {value === 0
          ? "None, just this one"
          : value === 1
            ? "One more machine"
            : `${value} more machines`}
      </span>
    </div>
  );
}
