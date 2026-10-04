/** The hub's servers, their logins, and the tool-call log, through the relay. */
import type { HubServerState } from "@t3-fleet/core/Api";
import { ExternalLinkIcon, LogInIcon, LogOutIcon, PlugIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState, LoadingRows, Page, UnavailableState } from "../components/common";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group, GroupLabel } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, isUnavailable, type HubCallT, type HubServerT } from "../lib/api";
import { useEvent, useResource, useStore } from "../lib/store";
import { ago, cn, plural, stamp } from "../lib/utils";

const STATE: Readonly<Record<HubServerState, BadgeVariant>> = {
  running: "success",
  starting: "info",
  "needs-login": "warning",
  error: "error",
  stopped: "secondary",
};

const OUTCOME: Readonly<Record<HubCallT["outcome"], BadgeVariant>> = {
  ok: "success",
  error: "error",
  denied: "warning",
  unauthorized: "warning",
};

export function McpView() {
  const { session } = useStore();
  const servers = useResource(api.hubServers);
  useEvent("hub", () => void servers.reload());
  const unavailable = servers.data === null && isUnavailable(servers.error);
  return (
    <Page
      wide
      title="MCP"
      description={session?.relay === null ? "This fleet has no relay" : "Servers the hub runs on the relay, and every tool call through its gateway"}
      actions={
        <Button size="sm" variant="outline" disabled={servers.loading} onClick={() => void servers.reload()}>
          {servers.loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          Refresh
        </Button>
      }
    >
      {unavailable ? (
        <Group>
          <UnavailableState error={servers.error} title="The MCP hub is not available">
            {session?.relay === null
              ? "The hub runs inside the relay. Add [relay] url to fleetx.toml and run `t3-fleet relay serve` on the relay node."
              : "The relay did not answer for the hub. It may be running a T3 Fleet without the hub, or not running at all."}
          </UnavailableState>
        </Group>
      ) : (
        <>
          <section>
            <GroupLabel>Servers</GroupLabel>
            <Group>
              {servers.data === null ? (
                servers.error === null ? (
                  <LoadingRows rows={3} />
                ) : (
                  <ErrorState error={servers.error} what="the hub's servers" onRetry={() => void servers.reload()} />
                )
              ) : servers.data.length === 0 ? (
                <Empty icon={<PlugIcon />} title="No hosted servers">
                  Definitions in the config repo's <code>mcp/</code> with a hosted kind (remote, container, registry, hosted-stdio) are served here.
                </Empty>
              ) : (
                servers.data.map((s) => <ServerRow key={s.name} server={s} onChanged={() => void servers.reload()} />)
              )}
            </Group>
          </section>
          <CallLog servers={servers.data ?? []} />
        </>
      )}
    </Page>
  );
}

function ServerRow({ server: s, onChanged }: { server: HubServerT; onChanged: () => void }) {
  const { now } = useStore();
  const [confirm, setConfirm] = useState<"logout" | "restart" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    // Opened before the request, so the browser does not treat it as an unrequested popup.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await api.hubLogin(s.name);
      if (tab === null) window.location.assign(url);
      else {
        // The sign-in page gets no handle on this one.
        tab.opener = null;
        tab.location.href = url;
      }
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sm">{s.name}</span>
        <Badge variant={STATE[s.state]}>{s.state}</Badge>
        <Badge variant="outline">{s.kind}</Badge>
        {s.auth === "none" ? null : <Badge variant="outline">{s.auth}</Badge>}
        <span className="ml-auto flex gap-1.5">
          {s.auth === "oauth" ? (
            s.state === "needs-login" || s.expiresAt === null ? (
              <Button size="xs" variant={s.state === "needs-login" ? "default" : "outline"} disabled={busy} onClick={() => void signIn()}>
                {busy ? <Spinner className="size-3" /> : <LogInIcon />}
                Sign in
                <ExternalLinkIcon className="size-3" />
              </Button>
            ) : (
              <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirm("logout")}>
                <LogOutIcon />
                Sign out
              </Button>
            )
          ) : null}
          <Button size="xs" variant="outline" disabled={busy} onClick={() => setConfirm("restart")}>
            <RotateCwIcon />
            Restart
          </Button>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground text-xs">
        <span className="max-w-full truncate font-mono" title={s.upstream}>
          {s.upstream}
        </span>
        {s.tools === null ? null : <span>{plural(s.tools, "tool")}</span>}
        {s.expiresAt === null ? null : <span>token {s.expiresAt > now ? `expires ${stamp(s.expiresAt)}` : "expired"}</span>}
        {s.lastCheckAt === null ? null : <span>checked {ago(s.lastCheckAt, now)}</span>}
      </div>
      {s.detail === null ? null : <div className={cn("text-xs", s.state === "error" ? "text-destructive-foreground" : "text-muted-foreground")}>{s.detail}</div>}
      {error === null ? null : <div className="text-destructive-foreground text-xs">{error}</div>}
      <ConfirmHub server={s} verb={confirm} onClose={() => setConfirm(null)} onDone={onChanged} />
    </div>
  );
}

function ConfirmHub({ server, verb, onClose, onDone }: { server: HubServerT; verb: "logout" | "restart" | null; onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      await (verb === "logout" ? api.hubLogout(server.name) : api.hubRestart(server.name));
      onClose();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <AlertDialog open={verb !== null} onOpenChange={(open) => !open && !running && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {verb === "logout" ? "Sign out of" : "Restart"} {server.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {verb === "logout"
              ? "The hub forgets this server's tokens. Every client loses it until someone signs in again."
              : "Calls in flight through this server fail while it restarts."}
          </AlertDialogDescription>
          {error === null ? null : <div className="text-destructive-foreground text-xs">{error}</div>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" disabled={running} />}>Cancel</AlertDialogClose>
          <Button variant={verb === "logout" ? "destructive" : "default"} disabled={running} onClick={() => void run()}>
            {running ? <Spinner className="size-3.5" /> : null}
            {verb === "logout" ? "Sign out" : "Restart"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function CallLog({ servers }: { servers: ReadonlyArray<HubServerT> }) {
  const { now } = useStore();
  const [server, setServer] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<HubCallT["outcome"] | null>(null);
  const calls = useResource(() => api.hubCalls(server), [server]);
  useEvent("hub", () => void calls.reload());
  const shown = (calls.data ?? []).filter((c) => outcome === null || c.outcome === outcome).toSorted((a, b) => b.at - a.at);
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
        <h2 className="font-medium text-muted-foreground text-xs">Tool calls</h2>
        <select
          aria-label="Server"
          value={server ?? ""}
          onChange={(e) => setServer(e.target.value === "" ? null : e.target.value)}
          className="ml-auto h-6 rounded-md border border-input bg-popover px-1.5 text-xs"
        >
          <option value="">Every server</option>
          {servers.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Outcome"
          value={outcome ?? ""}
          onChange={(e) => setOutcome(e.target.value === "" ? null : (e.target.value as HubCallT["outcome"]))}
          className="h-6 rounded-md border border-input bg-popover px-1.5 text-xs"
        >
          <option value="">Every outcome</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="denied">denied</option>
          <option value="unauthorized">unauthorized</option>
        </select>
        <Button size="icon-xs" variant="ghost-muted" aria-label="Refresh calls" onClick={() => void calls.reload()}>
          <RefreshCwIcon />
        </Button>
      </div>
      <Group>
        {calls.data === null ? (
          calls.error === null ? (
            <LoadingRows />
          ) : (
            <ErrorState error={calls.error} what="the call log" onRetry={() => void calls.reload()} />
          )
        ) : shown.length === 0 ? (
          <Empty title="No calls">Calls through the gateway show up here: server, client, tool, duration and outcome, never arguments or results.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Server</th>
                  <th className="px-2 py-2 font-medium">Client</th>
                  <th className="px-2 py-2 font-medium">Method</th>
                  <th className="px-2 py-2 font-medium">Tool</th>
                  <th className="px-2 py-2 text-right font-medium">Duration</th>
                  <th className="px-2 py-2 pr-4 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c, i) => (
                  <tr key={`${c.at}-${i}`} className="border-b last:border-0 hover:bg-muted/50" title={c.error ?? undefined}>
                    <td className="whitespace-nowrap px-4 py-1.5 text-muted-foreground tabular-nums" title={stamp(c.at)}>
                      {ago(c.at, now)}
                    </td>
                    <td className="px-2 py-1.5 font-medium">{c.server}</td>
                    <td className="px-2 py-1.5">{c.client}</td>
                    <td className="px-2 py-1.5 font-mono">{c.method}</td>
                    <td className="px-2 py-1.5 font-mono">{c.tool ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{c.durationMs} ms</td>
                    <td className="px-2 py-1.5 pr-4">
                      <Badge variant={OUTCOME[c.outcome]}>{c.outcome}</Badge>
                      {c.error === null ? null : <span className="ml-2 text-muted-foreground">{c.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Group>
    </section>
  );
}
