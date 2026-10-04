/** The check every view shows: when it ran, a button to run it now, and why the last one failed. */
import { RefreshCwIcon } from "lucide-react";

import { useStore } from "../lib/store";
import { ago, plural } from "../lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export function CheckButton() {
  const { checking, recheck } = useStore();
  return (
    <Button size="sm" variant="outline" disabled={checking} onClick={() => void recheck()}>
      {checking ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
      {checking ? "Checking…" : "Check now"}
    </Button>
  );
}

export function CheckedLine() {
  const { status, now } = useStore();
  if (status === null) return <>checking every machine…</>;
  const errors = status.findings.filter((f) => f.severity === "error").length;
  const warns = status.findings.filter((f) => f.severity === "warn").length;
  const parts = [plural(status.environments.length, "environment")];
  if (errors + warns === 0) parts.push("everything matches");
  if (errors > 0) parts.push(plural(errors, "problem"));
  if (warns > 0) parts.push(plural(warns, "warning"));
  parts.push(`checked ${ago(status.checkedAt, now)} in ${(status.elapsedMs / 1000).toFixed(1)}s`);
  return <>{parts.join(" · ")}</>;
}

/** Shown above a status when the check after it failed. */
export function CheckFailed() {
  const { status, statusError } = useStore();
  if (status === null || statusError === null) return null;
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-error-surface px-3 py-2 text-destructive-foreground text-xs">
      The last check failed: {statusError instanceof Error ? statusError.message : String(statusError)}. Showing the one before.
    </div>
  );
}
