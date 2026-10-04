/** A machine's merged settings, and the layer each value comes from (`t3-fleet config show`). */
import { SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { ErrorState, LoadingRows, Page } from "../components/common";
import { Badge, type BadgeVariant } from "../components/ui/badge";
import { Empty } from "../components/ui/empty";
import { Group } from "../components/ui/group";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { useResource, useStore } from "../lib/store";

const sourceVariant = (source: string): BadgeVariant =>
  source.startsWith("node ") ? "info" : source.startsWith("profile ") ? "outline" : source === "defaults" ? "secondary" : "warning";

export function ConfigView({ node }: { node: string }) {
  const { session, sessionError } = useStore();
  const selected = node !== "" ? node : (session?.self ?? "");
  const rows = useResource(() => (selected === "" ? Promise.resolve(null) : api.config(selected)), [selected]);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = (rows.data ?? []).filter(
    (r) => needle === "" || r.path.toLowerCase().includes(needle) || r.value.toLowerCase().includes(needle) || r.source.toLowerCase().includes(needle),
  );
  return (
    <Page
      wide
      title="Config"
      description="Defaults, then each profile the machine lists, then its own file; later layers win"
      actions={
        session === null ? undefined : (
          <select
            aria-label="Machine"
            value={selected}
            onChange={(e) => navigate(`/config/${encodeURIComponent(e.target.value)}`)}
            className="h-7 rounded-[var(--control-radius)] border border-input bg-popover px-2 text-sm"
          >
            {session.nodes.map((n) => (
              <option key={n} value={n}>
                {n}
                {n === session.self ? " (this machine)" : ""}
              </option>
            ))}
          </select>
        )
      }
    >
      <label className="flex h-8 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-popover px-2.5 text-sm shadow-xs/5 focus-within:ring-2 focus-within:ring-ring">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by key, value or layer"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </label>
      <Group>
        {selected === "" && sessionError !== null ? (
          // Without the session there is no machine to start from.
          <ErrorState error={sessionError} what="this machine's name" />
        ) : rows.error !== null ? (
          <ErrorState error={rows.error} what={`${selected}'s settings`} onRetry={() => void rows.reload()} />
        ) : rows.data === null ? (
          <LoadingRows rows={6} />
        ) : shown.length === 0 ? (
          <Empty icon={<SlidersHorizontalIcon />} title={rows.data.length === 0 ? "No settings" : "Nothing matches"}>
            {rows.data.length === 0 ? `${selected} uses T3 Fleet's defaults for everything.` : "Try a shorter filter."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-2 py-2 font-medium">Value</th>
                  <th className="px-2 py-2 pr-4 text-right font-medium">From</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.path} className="border-b align-top last:border-0 hover:bg-muted/50">
                    <td className="whitespace-nowrap px-4 py-1.5 font-mono">{r.path}</td>
                    <td className="break-all px-2 py-1.5 font-mono text-muted-foreground">{r.value}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 pr-4 text-right">
                      <Badge variant={sourceVariant(r.source)}>{r.source}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Group>
    </Page>
  );
}
