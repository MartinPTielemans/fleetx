/** Per machine: each provider's login under T3, and the model proxy's traffic per upstream over three windows. */
import type { ModelUpstreamStats, ModelWindow } from "@t3-fleet/core/Api";
import { ActivityIcon, RefreshCwIcon } from "lucide-react";

import { ErrorState, LoadingRows, Page, SeverityIcon, UnavailableState, type Severity } from "../components/common";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Group, GroupLabel } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, type UiModelsT } from "../lib/api";
import { instanceLabel, providerLogins, statusText, upstreamLabel } from "../lib/providers";
import { useEvent, useResource, useStore } from "../lib/store";
import { ago, cn, stamp } from "../lib/utils";

type NodeModels = UiModelsT["nodes"][number];

/** More than 5% failed in the hour, or any fallback: the threshold the models-failing finding uses. */
const health = (w: ModelWindow): Severity =>
  w.requests > 0 && w.failed / w.requests > 0.05 ? "error" : w.fallbacks > 0 || w.failed > 0 ? "warn" : "ok";

export function ModelsView() {
  const models = useResource(api.models);
  // The model facts come with each check.
  useEvent("check", () => void models.reload());
  const nodes = models.data?.nodes ?? [];
  const reporting = nodes.filter((n) => n.stats !== null || providerLogins(n).length > 0);
  return (
    <Page
      wide
      title="Models"
      description="Each provider's login under T3, and traffic through the T3 Fleet model proxy, per machine"
      actions={
        <Button size="sm" variant="outline" disabled={models.loading} onClick={() => void models.reload()}>
          {models.loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          Refresh
        </Button>
      }
    >
      {models.data === null ? (
        <Group>{models.error === null ? <LoadingRows rows={3} /> : <ErrorState error={models.error} what="models" onRetry={() => void models.reload()} />}</Group>
      ) : reporting.length === 0 ? (
        <Group>
          <UnavailableState error={null} title="No machine reports model traffic yet">
            The model proxy and the provider login checks come with the models area. Once a machine runs <code>t3-fleet models serve</code>, its traffic shows up here after the next check.
          </UnavailableState>
        </Group>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {nodes.map((n) => (
            <NodeCard key={n.node} node={n} />
          ))}
        </div>
      )}
    </Page>
  );
}

function NodeCard({ node: n }: { node: NodeModels }) {
  const { now } = useStore();
  const logins = providerLogins(n);
  return (
    <section>
      <GroupLabel className="flex items-center gap-2">
        <span className="font-semibold text-foreground">{n.node}</span>
        {n.at === null ? <span>unreachable</span> : <span>observed {ago(n.at, now)}</span>}
      </GroupLabel>
      <Group>
        {logins.length === 0 ? (
          <div className="px-4 py-2.5 text-muted-foreground text-xs">No provider logins reported.</div>
        ) : (
          logins.map((l) => (
            <div key={l.instanceId} className="flex items-center gap-2 px-4 py-2 text-sm">
              <SeverityIcon severity={l.status === "authenticated" ? "ok" : l.status === "unauthenticated" ? "error" : "info"} className="size-3.5" />
              <span className="font-medium">{instanceLabel(l.instanceId)}</span>
              <span className="text-muted-foreground text-xs">{statusText[l.status]}</span>
              {l.method === null ? null : <Badge variant="outline">{l.method}</Badge>}
              {l.detail === "" ? null : (
                <span className="ml-auto max-w-[50%] truncate text-muted-foreground text-xs" title={l.detail}>
                  {l.detail}
                </span>
              )}
            </div>
          ))
        )}
        {n.stats === null ? (
          <div className="px-4 py-2.5 text-muted-foreground text-xs">The model proxy is not reporting on this machine.</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 px-4 py-2 text-muted-foreground text-xs">
              <span className="flex items-center gap-1.5">
                <ActivityIcon className="size-3" />
                proxy {n.stats.version}
              </span>
              <span>egress {n.stats.egress}</span>
              <span>up since {stamp(n.stats.startedAt)}</span>
            </div>
            {n.stats.upstreams.map((u) => (
              <Upstream key={u.upstream} stats={u} />
            ))}
          </>
        )}
      </Group>
    </section>
  );
}

const pct = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(part === 0 ? 0 : 1)}%`);
const ms = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function Upstream({ stats: u }: { stats: ModelUpstreamStats }) {
  const { now } = useStore();
  const windows: ReadonlyArray<[string, ModelWindow]> = [
    ["5 min", u.m5],
    ["1 hour", u.h1],
    ["24 hours", u.h24],
  ];
  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <SeverityIcon severity={health(u.h1)} className="size-3.5" />
        <span className="font-medium text-sm">{upstreamLabel(u.upstream)}</span>
      </div>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-medium" />
            <th className="py-1 text-right font-medium">Requests</th>
            <th className="py-1 text-right font-medium">Retried</th>
            <th className="py-1 text-right font-medium">Failed</th>
            <th className="py-1 text-right font-medium">Fallbacks</th>
            <th className="py-1 text-right font-medium">TTFB p50</th>
            <th className="py-1 text-right font-medium">p95</th>
          </tr>
        </thead>
        <tbody>
          {windows.map(([label, w]) => (
            <tr key={label} className="border-t border-border/50">
              <td className="py-1 text-muted-foreground">{label}</td>
              <td className="py-1 text-right">{w.requests}</td>
              <td className="py-1 text-right">{w.retried === 0 ? "0" : `${w.retried} · ${pct(w.retried, w.requests)}`}</td>
              <td className={cn("py-1 text-right", w.failed > 0 && "text-destructive-foreground")}>
                {w.failed === 0 ? "0" : `${w.failed} · ${pct(w.failed, w.requests)}`}
              </td>
              <td className={cn("py-1 text-right", w.fallbacks > 0 && "text-warning-foreground")}>{w.fallbacks}</td>
              <td className="py-1 text-right">{ms(w.ttfbP50Ms)}</td>
              <td className="py-1 text-right">{ms(w.ttfbP95Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {Object.keys(u.h24.failures).length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(u.h24.failures)
            .toSorted((a, b) => b[1] - a[1])
            .map(([kind, count]) => (
              <Badge key={kind} variant="outline">
                {kind} × {count}
              </Badge>
            ))}
          <span className="text-muted-foreground text-xs">in 24 hours</span>
        </div>
      )}
      {u.lastError === null ? null : (
        <div className="mt-2 text-xs">
          <span className="text-muted-foreground">last error {ago(u.lastError.at, now)}: </span>
          <Badge variant="error">{u.lastError.class}</Badge> <span className="break-words">{u.lastError.message}</span>
        </div>
      )}
    </div>
  );
}
