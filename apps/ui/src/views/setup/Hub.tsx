/** The hub: an ssh destination, checked from here (read-only), with what it lacks and how to fix it. */
import type { UiProbe, UiProbeItem } from "@t3-fleet/core/SetupApi";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  PlugZapIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Group } from "../../components/ui/group";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { CopyCommand, Field, inputClass, isCommand, Prose, StepFrame, Toggle } from "./parts";
import { nodeNameProblem, type Answers } from "./wizard";

export interface ProbeState {
  readonly data: UiProbe | null;
  readonly running: boolean;
  readonly error: unknown;
}

const REQUIRED: ReadonlyArray<{
  key: "fleet" | "node" | "git" | "t3" | "service";
  what: string;
}> = [
  { key: "fleet", what: "Not in another fleet" },
  { key: "node", what: "Node 24 or newer" },
  { key: "git", what: "git" },
  { key: "t3", what: "T3 Code" },
  { key: "service", what: "A service manager to keep the relay running" },
];
const RECOMMENDED: ReadonlyArray<{ key: "tailscale" | "docker"; what: string; why: string }> = [
  { key: "tailscale", what: "Tailscale", why: "so your other machines reach the relay" },
  { key: "docker", what: "Docker", why: "for MCP servers that run in containers" },
];

export function HubStep({
  answers,
  set,
  probe,
  onProbe,
  hint,
  onBack,
  onNext,
  onSkip,
}: {
  answers: Answers;
  set: (patch: Partial<Answers>) => void;
  probe: ProbeState;
  onProbe: () => void;
  hint: string | null;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  const ssh = answers.hubSsh.trim();
  const current = probe.data !== null && probe.data.ssh === ssh ? probe.data : null;
  const canCheck = ssh !== "" && !probe.running;
  return (
    <StepFrame
      title="Your hub"
      lead="The always-on machine sends each change to every machine the moment it happens, and serves this app on your tailnet, so the fleet opens from any of your machines. It can host your MCP servers too. Setup reaches it over ssh and only looks until you confirm the plan."
      back={onBack}
      hint={hint}
      actions={
        <Button disabled={hint !== null} onClick={onNext}>
          Continue
          <ArrowRightIcon />
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (current?.ready === true && hint === null) onNext();
            else if (canCheck) onProbe();
          }}
        >
          <label htmlFor="hub-ssh" className="font-medium text-xs">
            SSH destination
          </label>
          <div className="flex gap-2">
            <input
              id="hub-ssh"
              className={cn(inputClass, "font-mono")}
              placeholder="me@server"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={answers.hubSsh}
              onChange={(e) => set({ hubSsh: e.currentTarget.value, hubSkipped: false })}
              aria-describedby="hub-ssh-note"
            />
            <Button
              type="submit"
              variant={current === null ? "default" : "outline"}
              disabled={!canCheck}
            >
              {probe.running ? (
                <Spinner className="size-3.5" />
              ) : current === null ? null : (
                <RefreshCwIcon />
              )}
              {probe.running ? "Checking" : current === null ? "Check" : "Check again"}
            </Button>
          </div>
          <span id="hub-ssh-note" className="text-muted-foreground text-xs leading-5">
            Anything <code className="font-mono text-foreground/80">ssh</code> reaches from this
            computer without a password prompt: <code className="font-mono">me@box</code>, a Host
            from <code className="font-mono">~/.ssh/config</code>, a Tailscale name.
          </span>
        </form>

        <div aria-live="polite" className="flex flex-col gap-6">
          {probe.running ? (
            <Checking ssh={ssh} />
          ) : probe.error !== null ? (
            <Unreachable
              ssh={ssh}
              error={probe.error instanceof Error ? probe.error.message : String(probe.error)}
            />
          ) : current === null ? null : !current.reachable ? (
            <Unreachable ssh={current.ssh} error={current.error ?? "no answer"} />
          ) : (
            <Checklist probe={current} answers={answers} set={set} />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-dashed pt-5">
          <p className="min-w-0 flex-1 basis-64 text-muted-foreground text-xs leading-5">
            Not ready to do this now? Set up this computer alone and add the hub later: run{" "}
            <code className="font-mono text-foreground/80">t3-fleet setup … --relay</code> on it.
          </p>
          <Button size="sm" variant="ghost-muted" onClick={onSkip}>
            Skip the hub for now
          </Button>
        </div>
      </div>
    </StepFrame>
  );
}

function Checking({ ssh }: { ssh: string }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card/50 shadow-xs/5" aria-busy>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Spinner className="size-4 text-muted-foreground" />
        <span className="text-sm">
          Checking <span className="font-mono">{ssh}</span> over ssh…
        </span>
      </div>
      <div className="flex flex-col gap-3.5 px-4 py-4">
        {[48, 30, 38, 56, 34, 42].map((w, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Unreachable({ ssh, error }: { ssh: string; error: string }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-destructive/25 bg-error-surface p-4 motion-safe:animate-enter motion-reduce:animate-fade-in"
    >
      <div className="flex items-start gap-3">
        <PlugZapIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="font-medium text-destructive-foreground text-sm">
            Couldn't reach <span className="font-mono">{ssh}</span>
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-foreground/80 text-xs leading-5">
            {error}
          </pre>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 pl-7">
        <p className="text-foreground/80 text-xs leading-5">
          Setup connects the way a terminal on this computer would. Try it there; once it logs in
          without asking for a password, check again.
        </p>
        <CopyCommand command={`ssh ${ssh} true`} className="bg-background/70" />
      </div>
    </div>
  );
}

function Checklist({
  probe,
  answers,
  set,
}: {
  probe: UiProbe;
  answers: Answers;
  set: (patch: Partial<Answers>) => void;
}) {
  const missing = REQUIRED.filter((r) => probe[r.key].state !== "ok").length;
  const suggestions = RECOMMENDED.filter((r) => probe[r.key].state !== "ok").length;
  const status = !probe.ready
    ? {
        tone: "error" as const,
        text: `Needs ${missing === 1 ? "one thing" : `${missing || "a few"} things`} before it can be the hub`,
      }
    : suggestions > 0
      ? {
          tone: "warn" as const,
          text: `Ready, with ${suggestions === 1 ? "a suggestion" : `${suggestions} suggestions`}`,
        }
      : { tone: "ok" as const, text: "Ready to be your hub" };
  let row = 0;
  return (
    <>
      <section
        aria-label="What the hub has"
        className="overflow-hidden rounded-xl border bg-card/50 shadow-xs/5"
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-info/25 bg-info/8 text-info-foreground dark:bg-info/14">
            <ServerIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 basis-40">
            <div className="font-medium text-sm [overflow-wrap:anywhere]">
              {probe.hostname ?? probe.ssh}
            </div>
            <div className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {[probe.os, `reached as ${probe.ssh}`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <span
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 font-medium text-xs",
              status.tone === "ok" && "bg-success/10 text-success-foreground dark:bg-success/16",
              status.tone === "warn" && "bg-warning/10 text-warning-foreground dark:bg-warning/16",
              status.tone === "error" &&
                "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
            )}
          >
            <StateIcon
              state={status.tone === "ok" ? "ok" : status.tone === "warn" ? "warn" : "missing"}
              small
            />
            {status.text}
          </span>
        </header>
        <ul className="flex flex-col py-1.5">
          {REQUIRED.map((r) => (
            <Item key={r.key} item={probe[r.key]} fallback={r.what} index={row++} />
          ))}
        </ul>
        <div className="border-t border-dashed px-4 pt-3 pb-1 font-medium text-muted-foreground text-xs">
          Recommended
        </div>
        <ul className="flex flex-col pb-1.5">
          {RECOMMENDED.map((r) => (
            <Item
              key={r.key}
              item={probe[r.key]}
              fallback={r.what}
              why={r.why}
              recommended
              index={row++}
            />
          ))}
        </ul>
        {probe.relayUrl === null ? null : (
          <div className="flex items-center gap-2 border-t bg-muted/40 px-4 py-2.5 text-xs">
            <RadioTowerIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">Relay at</span>
            <span className="truncate font-mono">{probe.relayUrl}</span>
          </div>
        )}
      </section>
      {probe.ready ? (
        <div className="flex flex-col gap-6 motion-safe:animate-enter motion-reduce:animate-fade-in">
          <Field
            className="max-w-xs"
            label="The hub's name in the fleet"
            value={answers.hubNode}
            onChange={(e) => set({ hubNode: e.currentTarget.value })}
            problem={
              nodeNameProblem(answers.hubNode) ??
              (answers.hubNode === answers.node ? "This computer already has that name" : null)
            }
            maxLength={63}
          />
          <Group>
            <Toggle
              title="Host your MCP servers on the hub"
              description={
                probe.relayUrl === null
                  ? "Needs Tailscale on the hub, so your machines can reach the servers there."
                  : "Sign in to each server once, on the hub, and every machine uses it. Until you sign in there, those servers stop working on your machines."
              }
              disabled={probe.relayUrl === null}
              checked={answers.hubMcp && probe.relayUrl !== null}
              onChange={(hubMcp) => set({ hubMcp })}
            />
          </Group>
        </div>
      ) : null}
    </>
  );
}

function Item({
  item,
  fallback,
  why,
  recommended = false,
  index,
}: {
  item: UiProbeItem;
  fallback: string;
  why?: string;
  recommended?: boolean;
  index: number;
}) {
  const state = item.state === "missing" && recommended ? "warn" : item.state;
  return (
    <li
      className="flex items-start gap-3 px-4 py-2 motion-safe:animate-enter motion-reduce:animate-fade-in"
      style={{ animationDelay: `${index * 35}ms` }}
    >
      <StateIcon state={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-sm leading-5">
          {item.label === "" ? fallback : item.label}
          {why !== undefined && item.state !== "ok" ? (
            <span className="text-muted-foreground"> · {why}</span>
          ) : null}
        </div>
        {item.state === "ok" || item.remedy === null ? null : isCommand(item.remedy) ? (
          <CopyCommand command={item.remedy} />
        ) : (
          <p className="text-pretty text-muted-foreground text-xs leading-5">
            <Prose text={item.remedy} />
          </p>
        )}
      </div>
    </li>
  );
}

function StateIcon({
  state,
  small = false,
}: {
  state: UiProbeItem["state"];
  small?: boolean;
}): ReactNode {
  const c = cn("shrink-0", small ? "size-3.5" : "mt-0.5 size-4");
  switch (state) {
    case "ok":
      return <CircleCheckIcon aria-label="there" className={cn(c, "text-success")} />;
    case "missing":
      return <CircleXIcon aria-label="missing" className={cn(c, "text-destructive")} />;
    case "warn":
      return <AlertTriangleIcon aria-label="needs attention" className={cn(c, "text-warning")} />;
    case "unknown":
      return (
        <CircleDashedIcon aria-label="could not tell" className={cn(c, "text-muted-foreground")} />
      );
  }
}
