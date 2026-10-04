/** Every health change the machines published, newest first. Reading them here marks nothing seen. */
import { BellOffIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState, LoadingRows, Page } from "../components/common";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group } from "../components/ui/group";
import { Spinner } from "../components/ui/spinner";
import { api, type UiAlertT } from "../lib/api";
import { useEvent, useResource, useStore } from "../lib/store";
import { ago, stamp } from "../lib/utils";

const KIND: Readonly<Record<UiAlertT["kind"], BadgeVariant>> = {
  failing: "error",
  problem: "warning",
  recovered: "success",
  resolved: "success",
};

export function AlertsView() {
  const { now } = useStore();
  const alerts = useResource(api.alerts);
  const [node, setNode] = useState<string | null>(null);
  useEvent("state", () => void alerts.reload());
  const list = alerts.data ?? [];
  const nodes = [...new Set(list.map((a) => a.node))].sort();
  const shown = node === null ? list : list.filter((a) => a.node === node);
  return (
    <Page
      title="Alerts"
      description="Health changes every machine reported through sync"
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={alerts.loading}
          onClick={() => void alerts.reload()}
        >
          {alerts.loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          Refresh
        </Button>
      }
    >
      {nodes.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          <Button
            size="xs"
            variant={node === null ? "outline" : "ghost-muted"}
            onClick={() => setNode(null)}
          >
            All machines
          </Button>
          {nodes.map((n) => (
            <Button
              key={n}
              size="xs"
              variant={node === n ? "outline" : "ghost-muted"}
              onClick={() => setNode(n)}
            >
              {n}
            </Button>
          ))}
        </div>
      ) : null}
      <Group>
        {alerts.data === null ? (
          alerts.error === null ? (
            <LoadingRows />
          ) : (
            <ErrorState error={alerts.error} what="alerts" onRetry={() => void alerts.reload()} />
          )
        ) : shown.length === 0 ? (
          <Empty icon={<BellOffIcon />} title="No alerts">
            Machines publish one when a problem appears or is resolved, or when their sync starts
            failing or recovers.
          </Empty>
        ) : (
          shown.map((a, i) => (
            <div
              key={`${a.at}-${a.node}-${i}`}
              className="flex items-baseline gap-3 px-4 py-2.5 text-sm"
            >
              <span
                className="w-28 shrink-0 text-muted-foreground text-xs tabular-nums"
                title={stamp(a.at)}
              >
                {ago(a.at, now)}
              </span>
              <span className="w-20 shrink-0">
                <Badge variant={KIND[a.kind]}>{a.kind}</Badge>
              </span>
              <span className="w-28 shrink-0 truncate font-medium">{a.node}</span>
              <span className="min-w-0 flex-1 break-words">{a.message}</span>
            </div>
          ))
        )}
      </Group>
    </Page>
  );
}
