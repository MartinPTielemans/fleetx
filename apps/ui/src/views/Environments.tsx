/** The status table, live; each machine opens to everything T3 Fleet saw there. */
import type { UiEnvironment, UiFinding } from "@t3-fleet/core/Api";
import { ChevronRightIcon, ServerIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { CheckButton, CheckedLine, CheckFailed } from "../components/check";
import {
  Code,
  ErrorState,
  LoadingRows,
  Page,
  SeverityIcon,
  worst,
  type Severity,
} from "../components/common";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { Group, GroupLabel } from "../components/ui/group";
import { providerLogins, statusText } from "../lib/providers";
import { follow, navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { ago, cn, plural, shortT3 } from "../lib/utils";

export function EnvironmentsView({ open }: { open: string }) {
  const { status, statusError, recheck } = useStore();
  const [showText, setShowText] = useState(false);
  // Agent CLI columns come from what the machines report, as the CLI's table does.
  const agentNames = [
    ...new Set((status?.environments ?? []).flatMap((e) => e.agents.map((a) => a.name))),
  ];
  return (
    <Page
      wide
      title="Environments"
      description={<CheckedLine />}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost-muted"
            onClick={() => setShowText((v) => !v)}
            aria-pressed={showText}
          >
            <TerminalIcon />
            <span className="max-sm:hidden">As text</span>
          </Button>
          <CheckButton />
        </>
      }
    >
      {status === null ? (
        statusError === null ? (
          <Group>
            <LoadingRows rows={3} />
          </Group>
        ) : (
          <Group>
            <ErrorState error={statusError} what="the check" onRetry={() => void recheck()} />
          </Group>
        )
      ) : (
        <>
          <CheckFailed />
          {showText ? <Code className="text-[0.6875rem]">{status.summary}</Code> : null}
          {status.environments.length === 0 ? (
            <Group>
              <Empty icon={<ServerIcon />} title="No machines">
                Add a file under <code>nodes/</code> in your config repo.
              </Empty>
            </Group>
          ) : (
            <Group>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground text-xs">
                      <th className="w-6 py-2 pl-3" />
                      <th className="px-2 py-2 font-medium">Machine</th>
                      <th className="px-2 py-2 font-medium">T3</th>
                      {agentNames.map((a) => (
                        <th key={a} className="px-2 py-2 font-medium capitalize">
                          {a}
                        </th>
                      ))}
                      <th className="px-2 py-2 font-medium">Providers in T3</th>
                      <th className="px-2 py-2 pr-4 font-medium">Sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.environments.map((env) => (
                      <EnvironmentRow
                        key={env.name}
                        env={env}
                        agentNames={agentNames}
                        findings={status.findings.filter((f) => f.node === env.name)}
                        open={open === env.name}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </Group>
          )}
        </>
      )}
    </Page>
  );
}

const areaSeverity = (
  findings: ReadonlyArray<UiFinding>,
  test: (f: UiFinding) => boolean,
): Severity =>
  worst(findings.filter((f) => f.severity !== "info" && test(f)).map((f) => f.severity));

function Cell({
  severity,
  children,
  muted = false,
}: {
  severity: Severity | null;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        muted && "text-muted-foreground",
      )}
    >
      {severity === null ? null : <SeverityIcon severity={severity} className="size-3.5" />}
      {children}
    </span>
  );
}

function EnvironmentRow({
  env,
  agentNames,
  findings,
  open,
}: {
  env: UiEnvironment;
  agentNames: ReadonlyArray<string>;
  findings: ReadonlyArray<UiFinding>;
  open: boolean;
}) {
  const { now } = useStore();
  const overall = env.reachable ? worst(findings.map((f) => f.severity)) : "error";
  const agent = (name: string) => {
    const a = env.agents.find((x) => x.name === name);
    if (a === undefined || a.version === null) return <Cell severity="error">missing</Cell>;
    const sev = areaSeverity(findings, (f) => f.area === "agents" && f.title.includes(name));
    const behind = a.latest !== null && a.latest !== a.version;
    return (
      <Cell severity={sev}>
        <span className="font-mono text-xs">{a.version}</span>
        {behind ? <span className="text-muted-foreground text-xs">→ {a.latest}</span> : null}
      </Cell>
    );
  };
  const t3 = () => {
    if (env.t3.version === null) return <Cell severity="error">not running</Cell>;
    const sev = areaSeverity(findings, (f) => f.area === "t3");
    return (
      <Cell severity={sev}>
        <span className="font-mono text-xs">{shortT3(env.t3.version)}</span>
        {env.t3.behind !== null && env.t3.behind > 0 ? (
          <Badge variant={sev === "ok" ? "secondary" : "warning"}>-{env.t3.behind}</Badge>
        ) : null}
      </Cell>
    );
  };
  const enabled = env.providers.filter((p) => p.enabled);
  const href = open ? "/environments" : `/environments/${encodeURIComponent(env.name)}`;
  return (
    <>
      {/* The whole row opens it for the mouse; the machine's name is the link for everyone else. */}
      <tr
        className={cn(
          "cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/60",
          open && "bg-muted/60",
        )}
        onClick={() => navigate(href)}
      >
        <td className="py-2.5 pl-3">
          <ChevronRightIcon
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </td>
        <td className="px-2 py-2.5">
          <span className="flex items-center gap-2 whitespace-nowrap">
            <SeverityIcon severity={overall} className="size-3.5" />
            <a
              href={href}
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation();
                follow(event);
              }}
              className="rounded-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {env.name}
            </a>
            {env.roles
              .filter((r) => r !== "member")
              .map((r) => (
                <Badge key={r} variant="outline">
                  {r}
                </Badge>
              ))}
          </span>
        </td>
        {env.reachable ? (
          <>
            <td className="px-2 py-2.5">{t3()}</td>
            {agentNames.map((a) => (
              <td key={a} className="px-2 py-2.5">
                {agent(a)}
              </td>
            ))}
            <td className="px-2 py-2.5">
              {enabled.length === 0 ? (
                <Cell severity={null} muted>
                  none enabled
                </Cell>
              ) : (
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {enabled.map((p) => (
                    <Cell
                      key={p.instanceId}
                      severity={
                        p.startsInT3
                          ? areaSeverity(
                              findings,
                              (f) =>
                                (f.area === "providers" || f.area === "parity") &&
                                f.title.includes(p.label),
                            )
                          : "error"
                      }
                    >
                      {p.label}
                    </Cell>
                  ))}
                </span>
              )}
            </td>
          </>
        ) : (
          <td colSpan={agentNames.length + 2} className="px-2 py-2.5">
            <Cell severity={null} muted>
              <span className="text-destructive-foreground">unreachable</span>
              <span className="max-w-md truncate text-xs">{env.error}</span>
            </Cell>
          </td>
        )}
        <td className="px-2 py-2.5 pr-4">
          {env.sync === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <Cell
              severity={
                env.sync.result === "ok" && env.sync.streak === 0
                  ? areaSeverity(findings, (f) => f.area === "sync")
                  : "error"
              }
            >
              <span className="text-xs">{ago(env.sync.at, now)}</span>
            </Cell>
          )}
        </td>
      </tr>
      {open ? (
        <tr className="border-b last:border-0">
          <td colSpan={agentNames.length + 5} className="bg-muted/30 p-0">
            <EnvironmentDetail env={env} findings={findings} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 px-3 py-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

function EnvironmentDetail({
  env,
  findings,
}: {
  env: UiEnvironment;
  findings: ReadonlyArray<UiFinding>;
}) {
  const { now } = useStore();
  const shown = findings.filter((f) => f.severity !== "info");
  const notes = findings.length - shown.length;
  const logins = providerLogins(env);
  return (
    <div className="grid gap-5 p-4 lg:grid-cols-2">
      <section>
        <GroupLabel>Machine</GroupLabel>
        <Group>
          <Fact label="Platform">{env.platform ?? "—"}</Fact>
          <Fact label="Roles">{env.roles.join(", ")}</Fact>
          <Fact label="T3 server">
            {env.t3.version === null ? (
              "not running"
            ) : (
              <span className="font-mono">{env.t3.version}</span>
            )}
            {env.t3.channel === null ? "" : ` · ${env.t3.channel}`}
            {env.t3.behind === null || env.t3.behind === 0
              ? ""
              : ` · ${plural(env.t3.behind, "release")} behind`}
          </Fact>
          {env.agents.map((a) => (
            <Fact key={a.name} label={`${a.name.charAt(0).toUpperCase()}${a.name.slice(1)} CLI`}>
              <span className="font-mono">{a.version ?? "missing"}</span>
              {a.latest !== null && a.latest !== a.version ? (
                <span className="text-muted-foreground"> · latest {a.latest}</span>
              ) : null}
            </Fact>
          ))}
          <Fact label="Sync">
            {env.sync === null ? (
              "no sync has reported"
            ) : (
              <span title={env.sync.message}>
                {env.sync.result === "ok"
                  ? "ok"
                  : `failing${env.sync.streak > 1 ? ` (${env.sync.streak} in a row)` : ""}`}{" "}
                · {ago(env.sync.at, now)} · {env.sync.message}
              </span>
            )}
          </Fact>
          <Fact label="Model proxy">
            {env.models === null ? (
              "not reported"
            ) : (
              <a href="/models" onClick={follow} className="underline-offset-2 hover:underline">
                {env.models.version} · {env.models.egress} ·{" "}
                {plural(
                  env.models.upstreams.reduce((n, u) => n + u.h1.requests, 0),
                  "request",
                )}{" "}
                in the last hour
              </a>
            )}
          </Fact>
        </Group>
      </section>
      <section>
        <GroupLabel>Providers in T3</GroupLabel>
        {env.providers.length === 0 ? (
          <Group>
            <div className="px-3 py-3 text-muted-foreground text-xs">
              {env.reachable ? "T3 lists no providers here." : "Not reachable."}
            </div>
          </Group>
        ) : (
          <Group>
            {env.providers.map((p) => {
              const login = logins.find((l) => l.instanceId === p.instanceId);
              return (
                <div key={p.instanceId} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <SeverityIcon
                      severity={
                        !p.enabled
                          ? "info"
                          : !p.startsInT3 || login?.status === "unauthenticated"
                            ? "error"
                            : "ok"
                      }
                      className="size-3.5"
                    />
                    <span className="font-medium">{p.label}</span>
                    {!p.enabled ? <Badge variant="secondary">disabled</Badge> : null}
                    {login === undefined ? null : (
                      <Badge
                        variant={
                          login.status === "authenticated"
                            ? "success"
                            : login.status === "unauthenticated"
                              ? "error"
                              : "secondary"
                        }
                        title={login.detail}
                      >
                        {statusText[login.status]}
                        {login.method === null ? "" : ` · ${login.method}`}
                      </Badge>
                    )}
                    {p.viaModels ? <Badge variant="info">via t3-fleet models</Badge> : null}
                    <span className="ml-auto font-mono text-muted-foreground">
                      {p.version ?? ""}
                    </span>
                  </div>
                  {p.runs === null ? null : (
                    <div className="truncate pl-5.5 font-mono text-muted-foreground" title={p.runs}>
                      {p.runs}
                    </div>
                  )}
                </div>
              );
            })}
          </Group>
        )}
        <GroupLabel className="mt-5">Findings</GroupLabel>
        <Group>
          {shown.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs">
              <SeverityIcon severity="ok" className="size-3.5" />
              Nothing to fix here.
            </div>
          ) : (
            shown.map((f) => (
              <a
                key={f.id}
                href="/findings"
                onClick={follow}
                className="flex items-start gap-2 px-3 py-2 text-xs hover:bg-muted/60"
              >
                <SeverityIcon severity={f.severity} className="mt-px size-3.5" />
                <span className="min-w-0 flex-1">{f.title}</span>
                <Badge variant="outline">{f.area}</Badge>
              </a>
            ))
          )}
          {notes > 0 ? (
            <div className="px-3 py-2 text-muted-foreground text-xs">
              {plural(notes, "note")} on the Findings page
            </div>
          ) : null}
        </Group>
      </section>
    </div>
  );
}
