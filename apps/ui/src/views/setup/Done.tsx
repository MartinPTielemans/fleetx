/** Done: what the fleet is now, the line each other machine runs to join, and the way into the fleet. */
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BellRingIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  PlusIcon,
  ServerIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Failure } from "../../components/dialogs";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { api, type UiInvite, type UiNotifyTest } from "../../lib/api";
import { useAction } from "../../lib/store";
import { cn } from "../../lib/utils";
import { CopyCommand, inputClass, Prose, StepFrame } from "./parts";
import type { SetupRun } from "./run";
import { nodeNameProblem, settingParts } from "./wizard";

const SUGGESTED = ["desktop", "workstation", "studio", "travel", "office", "spare"];

/** "https://box.tailnet.ts.net/" → "box.tailnet.ts.net". */
const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function DoneStep({
  run,
  fleetUrl,
  onLeave,
  entering,
  enterError,
  onEnter,
}: {
  run: SetupRun | null;
  /** The hub's copy of the app, when the hub serves it; the way in then. */
  fleetUrl: string | null;
  onLeave: () => void;
  entering: boolean;
  enterError: unknown;
  onEnter: () => void;
}) {
  const [rows, setRows] = useState(() => Math.max(1, run?.others ?? 0));
  const taken = [run?.node, run?.hub?.node].filter((n): n is string => n !== undefined);
  return (
    <StepFrame
      title={
        <span className="flex items-center gap-3">
          <Check />
          Your fleet is ready
        </span>
      }
      lead={
        run?.remote === null
          ? `${run.node} holds the keys and approves what changes. Your setup is in a repository on this computer, ready for more machines once it has a remote.`
          : run?.hub == null
            ? `${run?.node ?? "This computer"} holds the keys and approves what changes. Each machine you add below joins with one command.`
            : `${run.node} holds the keys and approves what changes; ${run.hub.node} is the hub, always on for the rest. Each machine you add below joins with one command.`
      }
      actions={
        fleetUrl === null ? (
          <Button disabled={entering} onClick={onEnter}>
            {entering ? <Spinner className="size-3.5" /> : null}
            Open your fleet
            {entering ? null : <ArrowRightIcon />}
          </Button>
        ) : (
          <>
            <Button variant="ghost-muted" disabled={entering} onClick={onEnter}>
              {entering ? <Spinner className="size-3.5" /> : null}
              Open it here
            </Button>
            <Button
              render={<a href={fleetUrl} onClick={onLeave} />}
              title={fleetUrl}
              className="min-w-0 shrink"
            >
              <span className="truncate">Open your fleet at {hostOf(fleetUrl)}</span>
              <ArrowUpRightIcon />
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-10">
        <Failure error={enterError} />
        <ul aria-label="Your fleet" className="flex flex-wrap gap-2">
          <Chip
            icon={<LaptopIcon />}
            name={run?.node ?? "This computer"}
            role="Authority"
            tone="primary"
          />
          {run?.hub == null ? null : (
            <Chip icon={<ServerIcon />} name={run.hub.node} role="Hub" tone="hub" />
          )}
          {(run?.others ?? 0) === 0 ? null : (
            <Chip
              icon={<MonitorSmartphoneIcon />}
              name={run?.others === 1 ? "One to join" : `${run?.others} to join`}
              role=""
              tone="pending"
            />
          )}
        </ul>

        {run?.hub?.mcp === true ? <SignIn hub={run.hub.node} /> : null}

        {(run?.settings ?? []).length === 0 ? null : (
          <div className="-mt-4 flex flex-col gap-3 px-1">
            <ul aria-label="Set for you" className="flex flex-col gap-1.5">
              {(run?.settings ?? []).map((line) => (
                <li
                  key={line}
                  className="flex items-start gap-2 text-muted-foreground text-xs leading-5"
                >
                  <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
                  <span>
                    <Prose text={settingParts(line).text} />
                  </span>
                </li>
              ))}
            </ul>
            {(run?.settings ?? []).some((l) => settingParts(l).where?.startsWith("[notify]")) ? (
              <NotifyTest />
            ) : null}
          </div>
        )}

        {run?.remote === null ? (
          <NoRemote />
        ) : (
          <section aria-labelledby="add-machines" className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5 px-1">
              <h2 id="add-machines" className="font-semibold text-sm">
                Add your other machines
              </h2>
              <p className="text-pretty text-muted-foreground text-xs leading-5">
                Name a machine to make its invite, then run the line on it. It installs T3 Fleet
                there, brings what that machine has, and keeps it in step from then on. You can do
                this later from the fleet too.
              </p>
            </div>
            <ol className="flex flex-col gap-2.5">
              {Array.from({ length: rows }, (_, i) => (
                <Invite
                  key={i}
                  index={i}
                  placeholder={SUGGESTED[i % SUGGESTED.length] ?? "desktop"}
                  taken={taken}
                />
              ))}
            </ol>
            <div>
              <Button size="sm" variant="ghost-muted" onClick={() => setRows((n) => n + 1)}>
                <PlusIcon />
                Another machine
              </Button>
            </div>
          </section>
        )}
      </div>
    </StepFrame>
  );
}

/** One test alert through the paths just set up, as `t3-fleet notify test` sends it. */
function NotifyTest() {
  const action = useAction(api.setupNotifyTest);
  const [result, setResult] = useState<UiNotifyTest | null>(null);
  return (
    <div className="flex flex-col gap-1.5 pl-5.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          size="sm"
          variant="outline"
          disabled={action.running}
          onClick={() => void action.start().then((r) => r !== null && setResult(r))}
        >
          {action.running ? <Spinner className="size-3.5" /> : <BellRingIcon />}
          Send a test
        </Button>
        {result === null ? null : (
          <span
            aria-live="polite"
            className={cn(
              "text-xs",
              result.failed ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {result.lines.join(" · ")}
          </span>
        )}
      </div>
      <Failure error={action.error} />
    </div>
  );
}

/** The hub hosts the MCP servers now: each with a login needs it once, there, before it works again. */
function SignIn({ hub }: { hub: string }) {
  return (
    <section
      aria-labelledby="mcp-sign-in"
      className="flex flex-col gap-3 rounded-xl border border-warning/25 bg-warning-surface p-4"
    >
      <div className="flex items-start gap-3">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="mcp-sign-in" className="font-medium text-sm text-warning-foreground">
            Sign in to your MCP servers on {hub}
          </h2>
          <p className="text-pretty text-foreground/80 text-xs leading-5">
            Your MCP servers run on {hub} now. Each one with a login asks for it once, there; until
            then it doesn't work on your machines. The fleet's MCP view lists them with a sign-in
            button, or from a terminal:
          </p>
        </div>
      </div>
      <CopyCommand command="t3-fleet mcp servers" className="bg-background/70 sm:ml-7" />
    </section>
  );
}

/** A fleet only on this computer: another machine has nothing to clone yet, so no invites. */
function NoRemote() {
  return (
    <section
      aria-labelledby="add-machines"
      className="flex flex-col gap-3 rounded-xl border bg-card/50 p-4 shadow-xs/5"
    >
      <div className="flex flex-col gap-0.5">
        <h2 id="add-machines" className="font-semibold text-sm">
          Adding your other machines
        </h2>
        <p className="text-pretty text-muted-foreground text-xs leading-5">
          They join from the fleet's repository, and yours has no remote yet. Push it to a private
          repository, then make each machine's invite here in the fleet, or with:
        </p>
      </div>
      <CopyCommand command="t3-fleet invite <name>" className="max-w-sm" />
    </section>
  );
}

/** A check that draws itself once, the one celebration in setup. */
function Check() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/12 text-success motion-safe:animate-enter dark:bg-success/18">
      <svg viewBox="0 0 24 24" className="size-4.5" fill="none" aria-hidden>
        <path
          d="M5 12.5l4.5 4.5L19 7.5"
          pathLength={1}
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={1}
          className="motion-safe:animate-draw"
        />
      </svg>
    </span>
  );
}

function Chip({
  icon,
  name,
  role,
  tone,
}: {
  icon: ReactNode;
  name: string;
  role: string;
  tone: "primary" | "hub" | "pending";
}) {
  return (
    <li
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full border pr-3 pl-1.5 text-sm [&_svg]:size-3.5",
        tone === "pending" ? "border-dashed text-muted-foreground" : "bg-card shadow-xs/5",
      )}
    >
      <span
        className={cn(
          "flex size-5.5 items-center justify-center rounded-full",
          tone === "primary" && "bg-primary/10 text-primary dark:bg-primary/20",
          tone === "hub" && "bg-info/10 text-info-foreground dark:bg-info/18",
          tone === "pending" && "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="font-medium">{name}</span>
      {role === "" ? null : <span className="text-muted-foreground text-xs">{role}</span>}
    </li>
  );
}

function Invite({
  index,
  placeholder,
  taken,
}: {
  index: number;
  placeholder: string;
  taken: ReadonlyArray<string>;
}) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ name: string; invite: UiInvite } | null>(null);
  const action = useAction(api.setupInvite);
  const problem =
    name.trim() === ""
      ? null
      : (nodeNameProblem(name.trim()) ??
        (taken.includes(name.trim()) ? "Already in the fleet" : null));
  const create = async () => {
    const node = name.trim();
    if (node === "" || problem !== null) return;
    const invite = await action.start(node);
    if (invite !== null) setMade({ name: node, invite });
  };
  const id = `invite-${index}`;
  const stale = made !== null && made.name !== name.trim();
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card/50 p-4 shadow-xs/5">
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5">
          <label htmlFor={id} className="font-medium text-xs">
            Machine {index + 1}
          </label>
          <input
            id={id}
            className={inputClass}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={name}
            aria-invalid={problem !== null}
            aria-describedby={`${id}-note`}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          {problem === null ? null : (
            <span id={`${id}-note`} className="text-destructive-foreground text-xs">
              {problem}
            </span>
          )}
        </div>
        <Button
          type="submit"
          variant={made === null || stale ? "default" : "outline"}
          className="mt-[1.375rem]"
          disabled={
            name.trim() === "" || problem !== null || action.running || (made !== null && !stale)
          }
        >
          {action.running ? <Spinner className="size-3.5" /> : null}
          {made === null || stale ? "Make invite" : "Invite made"}
        </Button>
      </form>
      <Failure error={action.error} />
      {made === null || stale ? null : (
        <div className="flex flex-col gap-1.5 motion-safe:animate-enter motion-reduce:animate-fade-in">
          <span className="text-muted-foreground text-xs">
            Run this in a terminal on{" "}
            <span className="font-medium text-foreground">{made.name}</span>:
          </span>
          <CopyCommand command={made.invite.command} />
        </div>
      )}
    </li>
  );
}
