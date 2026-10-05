/** The shell: T3's sidebar on the left, one view on the right. */
import {
  BellIcon,
  BoxesIcon,
  GitPullRequestArrowIcon,
  MonitorIcon,
  MoonIcon,
  PlugIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunIcon,
  WrenchIcon,
  ActivityIcon,
  PlugZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type * as React from "react";
import type { UiSetupState } from "@t3-fleet/core/SetupApi";

import { Dot, ErrorState } from "./components/common";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { JobsTray } from "./components/Jobs";
import { Empty } from "./components/ui/empty";
import { Spinner } from "./components/ui/spinner";
import { ApiError, api } from "./lib/api";
import { follow, useRoute, type View } from "./lib/router";
import { StoreProvider, useStore } from "./lib/store";
import { useTheme, type ThemeChoice } from "./lib/theme";
import { cn } from "./lib/utils";
import { AlertsView } from "./views/Alerts";
import { ConfigView } from "./views/Config";
import { EnvironmentsView } from "./views/Environments";
import { FindingsView } from "./views/Findings";
import { McpView } from "./views/Mcp";
import { ModelsView } from "./views/Models";
import { ProposalsView } from "./views/Proposals";
import { loadRun, saveRun } from "./views/setup/run";
import { SetupWizard } from "./views/setup/Setup";
import { SkillsView } from "./views/Skills";

const NAV: ReadonlyArray<{ view: View; label: string; icon: React.ReactNode }> = [
  { view: "environments", label: "Environments", icon: <ServerIcon /> },
  { view: "findings", label: "Findings", icon: <WrenchIcon /> },
  { view: "proposals", label: "Proposals", icon: <GitPullRequestArrowIcon /> },
  { view: "alerts", label: "Alerts", icon: <BellIcon /> },
  { view: "skills", label: "Skills", icon: <SparklesIcon /> },
  { view: "mcp", label: "MCP", icon: <PlugIcon /> },
  { view: "models", label: "Models", icon: <ActivityIcon /> },
  { view: "config", label: "Config", icon: <SlidersHorizontalIcon /> },
];

type Gate =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "setup"; readonly state: UiSetupState }
  | { readonly kind: "fleet" };

/**
 * A machine in a fleet gets the fleet; one that is not yet, or whose setup
 * stopped part-way, gets the setup wizard, which hands over when it is done.
 * A server without the setup endpoints is a fleet's.
 */
export function App() {
  const [gate, setGate] = useState<Gate>({ kind: "loading" });
  const load = () => {
    setGate({ kind: "loading" });
    api.setupState().then(
      (state) => {
        // The wizard stays for a hub still to bring up, and for its last screen, the
        // invites, until the fleet is opened.
        if (state.stage === "member" && state.hub === null && loadRun()?.finished !== true) {
          saveRun(null);
          setGate({ kind: "fleet" });
        } else setGate({ kind: "setup", state });
      },
      (error: unknown) =>
        setGate(
          error instanceof ApiError && error.status === 404
            ? { kind: "fleet" }
            : { kind: "error", error },
        ),
    );
  };
  useEffect(load, []);
  if (gate.kind === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-5 text-muted-foreground motion-safe:animate-[fade-in_200ms_ease_400ms_both,spin_1s_linear_infinite]" />
      </div>
    );
  if (gate.kind === "error")
    return (
      <div className="flex h-full items-center justify-center p-8">
        <ErrorState error={gate.error} what="this machine's setup" onRetry={load} />
      </div>
    );
  return (
    <StoreProvider key={gate.kind}>
      {gate.kind === "setup" ? (
        <SetupWizard
          initial={gate.state}
          onMember={() => setGate({ kind: "fleet" })}
          railFooter={<ThemeSwitch />}
          banner={<Stale />}
        />
      ) : (
        <Shell />
      )}
    </StoreProvider>
  );
}

/** This tab could not get a token: the link was used, or there was none. */
export function NoSession({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Empty icon={<PlugZapIcon className="text-destructive" />} title={title}>
        <span className="block max-w-md break-words">{message}</span>
      </Empty>
    </div>
  );
}

/** Shown once the server says this page's token is not one it gave out: it was restarted. */
function Stale() {
  const { connection } = useStore();
  if (connection !== "stale") return null;
  return (
    <div
      role="alert"
      className="shrink-0 border-b border-destructive/30 bg-error-surface px-4 py-2 text-destructive-foreground text-xs"
    >
      This page belongs to an earlier run of <code>t3-fleet ui</code>, so what it shows may be old
      and nothing here works. Open the newest link it printed.
    </div>
  );
}

const CONNECTION_TEXT = {
  live: "live",
  lost: "reconnecting…",
  connecting: "connecting…",
  paused: "paused while hidden",
  stale: "from an earlier run",
} as const;

function Shell() {
  const { view, rest } = useRoute();
  return (
    <div className="flex h-full min-h-0">
      <Sidebar active={view} />
      <div className="flex min-w-0 flex-1 flex-col">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b bg-sidebar px-2 py-1.5 md:hidden">
          {NAV.map((item) => (
            <a
              key={item.view}
              href={`/${item.view}`}
              onClick={follow}
              data-active={item.view === view}
              className="shrink-0 rounded-md px-2.5 py-1 font-medium text-muted-foreground text-xs data-[active=true]:bg-sidebar-row-selected data-[active=true]:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <Stale />
        <div className="min-h-0 flex-1">
          <ErrorBoundary resetKey={`${view}/${rest}`}>
            {view === "environments" && <EnvironmentsView open={rest} />}
            {view === "findings" && <FindingsView />}
            {view === "proposals" && <ProposalsView />}
            {view === "alerts" && <AlertsView />}
            {view === "skills" && <SkillsView />}
            {view === "mcp" && <McpView />}
            {view === "models" && <ModelsView />}
            {view === "config" && <ConfigView node={rest} />}
          </ErrorBoundary>
        </div>
        <JobsTray />
      </div>
    </div>
  );
}

function Sidebar({ active }: { active: View }) {
  const { status, session, connection } = useStore();
  const problems = status?.findings.filter((f) => f.severity !== "info").length ?? 0;
  const errors = status?.findings.some((f) => f.severity === "error") ?? false;
  return (
    <aside className="hidden w-(--sidebar-width) shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-13 items-center gap-2 px-4">
        <BoxesIcon className="size-4.5 text-primary" />
        <span className="font-semibold text-sm tracking-tight">T3 Fleet</span>
        {session === null ? null : (
          <span className="ml-auto text-2xs text-sidebar-muted-foreground">{session.version}</span>
        )}
      </div>
      <nav className="flex flex-col gap-0.5 px-2 py-1">
        {NAV.map((item) => (
          <a
            key={item.view}
            href={`/${item.view}`}
            onClick={follow}
            data-active={item.view === active}
            className="flex h-8 items-center gap-2 rounded-[var(--control-radius)] px-2.5 font-medium text-sidebar-muted-foreground/80 text-sm outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-sidebar-row-selected data-[active=true]:text-sidebar-foreground data-[active=true]:shadow-xs/5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground/70 data-[active=true]:[&>svg]:text-sidebar-foreground"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
            {item.view === "findings" && problems > 0 ? (
              <span
                className={cn(
                  "ml-auto rounded-sm px-1 font-medium text-2xs tabular-nums",
                  errors
                    ? "bg-destructive/12 text-destructive-foreground"
                    : "bg-warning/12 text-warning-foreground",
                )}
              >
                {problems}
              </span>
            ) : null}
          </a>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border/70 px-3 py-3">
        <div className="flex items-center gap-2 text-2xs text-sidebar-muted-foreground">
          <Dot
            tone={
              connection === "live"
                ? "live"
                : connection === "lost" || connection === "stale"
                  ? "error"
                  : "muted"
            }
          />
          <span className="truncate">
            {CONNECTION_TEXT[connection]}
            {session === null ? "" : ` · on ${session.self}`}
          </span>
        </div>
        <ThemeSwitch />
      </div>
    </aside>
  );
}

function ThemeSwitch() {
  const [choice, setChoice] = useTheme();
  const options: ReadonlyArray<{ value: ThemeChoice; icon: React.ReactNode; label: string }> = [
    { value: "system", icon: <MonitorIcon />, label: "System" },
    { value: "light", icon: <SunIcon />, label: "Light" },
    { value: "dark", icon: <MoonIcon />, label: "Dark" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex gap-0.5 rounded-[var(--control-radius)] bg-accent p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={choice === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setChoice(o.value)}
          className="flex h-6 flex-1 cursor-pointer items-center justify-center rounded-[calc(var(--control-radius)-2px)] text-muted-foreground hover:text-foreground aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-xs/5 [&>svg]:size-3.5"
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
