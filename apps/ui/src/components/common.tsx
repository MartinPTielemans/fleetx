/** Pieces every view uses: the page frame, severity marks, and the states a resource can be in. */
import {
  AlertTriangleIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  PlugZapIcon,
  RefreshCwIcon,
} from "lucide-react";
import type * as React from "react";

import { isUnauthorized, isUnavailable } from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { Skeleton } from "./ui/skeleton";

export function Page({
  title,
  description,
  actions,
  children,
  wide = false,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto">
      <header className="surface-glass sticky top-0 z-10 border-b">
        <div
          className={cn(
            "mx-auto flex min-h-13 items-center gap-3 px-5 py-2.5 sm:px-8",
            wide ? "max-w-7xl" : "max-w-5xl",
          )}
        >
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold text-[0.9375rem] leading-6">{title}</h1>
            {description === undefined ? null : (
              <div className="truncate text-muted-foreground text-xs">{description}</div>
            )}
          </div>
          {actions === undefined ? null : (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      </header>
      <main
        className={cn(
          "mx-auto flex flex-col gap-6 px-5 py-6 sm:px-8",
          wide ? "max-w-7xl" : "max-w-5xl",
        )}
      >
        {children}
      </main>
    </div>
  );
}

export type Severity = "error" | "warn" | "info" | "ok";

export function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  const base = cn("size-4 shrink-0", className);
  switch (severity) {
    case "error":
      return <CircleXIcon aria-label="problem" className={cn(base, "text-destructive")} />;
    case "warn":
      return <AlertTriangleIcon aria-label="warning" className={cn(base, "text-warning")} />;
    case "info":
      return <CircleIcon aria-label="note" className={cn(base, "text-muted-foreground/70")} />;
    case "ok":
      return <CircleCheckIcon aria-label="ok" className={cn(base, "text-success")} />;
  }
}

export const worst = (severities: ReadonlyArray<string>): Severity =>
  severities.includes("error") ? "error" : severities.includes("warn") ? "warn" : "ok";

/** Loading bars shaped like the rows that will replace them. */
export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 17) % 45)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  what,
}: {
  error: unknown;
  onRetry?: () => void;
  what: string;
}) {
  const message = error instanceof Error ? error.message : String(error);
  if (isUnauthorized(error)) {
    return (
      <Empty icon={<PlugZapIcon />} title="This page has an old token">
        Each run of <code className="text-foreground">t3-fleet ui</code> makes a new one. Open the
        link it printed in your terminal.
      </Empty>
    );
  }
  return (
    <Empty
      icon={<AlertTriangleIcon className="text-destructive" />}
      title={`Could not load ${what}`}
    >
      <span className="block break-words">{message}</span>
      {onRetry === undefined ? null : (
        <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCwIcon />
          Try again
        </Button>
      )}
    </Empty>
  );
}

/** For parts that ship separately (the hub, the model proxy): absent is a state, not an error. */
export function UnavailableState({
  error,
  title,
  children,
}: {
  error: unknown;
  title: string;
  children: React.ReactNode;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Empty icon={<PlugZapIcon />} title={title}>
      {children}
      {isUnavailable(error) ? (
        <span className="mt-2 block text-muted-foreground/70 text-xs">{message}</span>
      ) : null}
    </Empty>
  );
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap break-all rounded-md border bg-code px-2.5 py-1.5 font-mono text-code-foreground text-xs leading-5",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function Dot({ tone }: { tone: "ok" | "warn" | "error" | "muted" | "live" }) {
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-success",
        tone === "live" && "bg-success motion-safe:animate-status-pulse",
        tone === "warn" && "bg-warning",
        tone === "error" && "bg-destructive",
        tone === "muted" && "bg-muted-foreground/40",
      )}
    />
  );
}
