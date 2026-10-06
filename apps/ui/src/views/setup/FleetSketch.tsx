/**
 * The layout `recommend` gives for what the user said, drawn as the fleet it
 * will be: this computer on top holding the keys, the hub under it, the other
 * machines last, joined by a line. It changes as they answer; that change is
 * the step's one piece of motion, so a new role arrives rather than appears.
 */
import { recommend } from "@t3-fleet/core/setup/Topology";
import {
  KeyRoundIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  ServerIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function FleetSketch({
  node,
  alwaysOn,
  others,
}: {
  node: string;
  alwaysOn: boolean | null;
  others: number;
}) {
  const rec = recommend({ alwaysOn: alwaysOn === true, others });
  // recommend gives the roles in order: this computer, then the hub when there is one, then the rest.
  const [self, ...rest] = rec.roles;
  const hub = rec.layout === "hub" ? rest[0] : undefined;
  const members = rec.layout === "hub" ? rest.slice(1) : rest;
  return (
    <section
      aria-label="Recommended layout"
      aria-live="polite"
      className="overflow-hidden rounded-2xl border bg-card shadow-black/5 shadow-lg dark:shadow-black/40"
    >
      <div key={rec.title} className="border-b bg-muted/60 px-4 py-3.5">
        <div className="font-semibold text-[0.9375rem] leading-6 motion-safe:animate-enter motion-reduce:animate-fade-in">
          {rec.title}
        </div>
        <p className="text-pretty text-muted-foreground text-xs leading-5 motion-safe:animate-enter motion-reduce:animate-fade-in">
          {rec.why}
        </p>
      </div>
      <ol className="flex flex-col px-4 py-4">
        {self === undefined ? null : (
          <Machine
            icon={<LaptopIcon />}
            name={
              <>
                This computer
                {node.trim() === "" ? null : (
                  <span className="font-normal text-muted-foreground"> · {node.trim()}</span>
                )}
              </>
            }
            role="Authority"
            roleIcon={<KeyRoundIcon />}
            tone="primary"
            does={self.does}
            line={hub !== undefined || alwaysOn === false || members.length > 0}
          />
        )}
        {hub !== undefined ? (
          <Machine
            key="hub"
            icon={<ServerIcon />}
            name={hub.machine}
            role="Hub"
            tone="hub"
            does={capital(hub.does.replace(/^Hub:\s*/, ""))}
            line={members.length > 0}
            arriving
          />
        ) : alwaysOn === false ? (
          <li
            key="no-hub"
            className="relative flex gap-3 pb-4 motion-safe:animate-enter motion-reduce:animate-fade-in"
          >
            <Connector dashed={members.length === 0} />
            <span className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-xl border border-dashed bg-card text-muted-foreground/70 [&_svg]:size-4">
              <MoonIcon />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="font-medium text-muted-foreground text-sm">No hub for now</div>
              <p className="text-pretty text-muted-foreground text-xs leading-5">
                A laptop can't be the hub: it sleeps, and the hub has to answer whenever a machine
                changes something. Add an always-on machine any time.
              </p>
            </div>
          </li>
        ) : null}
        {members.map((m) => (
          <Machine
            key={`members-${others}`}
            icon={<MonitorSmartphoneIcon />}
            name={m.machine}
            role={others === 1 ? "Member" : "Members"}
            tone="muted"
            does={m.does}
            count={others}
            arriving
          />
        ))}
      </ol>
    </section>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function Connector({ dashed = false }: { dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute top-9 bottom-0 left-[1.125rem] w-px",
        dashed ? "border-l border-dashed bg-transparent" : "bg-border",
      )}
    />
  );
}

function Machine({
  icon,
  name,
  role,
  roleIcon,
  tone,
  does,
  line = false,
  count = 1,
  arriving = false,
}: {
  icon: ReactNode;
  name: ReactNode;
  role: string;
  roleIcon?: ReactNode;
  tone: "primary" | "hub" | "muted";
  does: string;
  line?: boolean;
  count?: number;
  arriving?: boolean;
}) {
  return (
    <li
      className={cn(
        "relative flex gap-3",
        line && "pb-4",
        arriving && "motion-safe:animate-enter motion-reduce:animate-fade-in",
      )}
    >
      {line ? <Connector /> : null}
      <span className="relative z-10 shrink-0">
        {/* More than one machine: the tile stacked on the ones behind it. */}
        {count > 1 ? (
          <span
            aria-hidden
            className="absolute inset-0 translate-x-1 -translate-y-1 rounded-xl border bg-muted"
          />
        ) : null}
        <span
          className={cn(
            "relative flex size-9 items-center justify-center rounded-xl border shadow-xs/5 [&_svg]:size-4",
            tone === "primary" && "border-primary/25 bg-primary/8 text-primary dark:bg-primary/16",
            tone === "hub" && "border-info/25 bg-info/8 text-info-foreground dark:bg-info/14",
            tone === "muted" && "bg-card text-muted-foreground",
          )}
        >
          {icon}
        </span>
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-sm">{name}</span>
          <span
            className={cn(
              "inline-flex h-4.5 items-center gap-1 rounded-sm px-1.5 font-medium text-2xs [&_svg]:size-3",
              tone === "primary" && "bg-primary/10 text-primary dark:bg-primary/20",
              tone === "hub" && "bg-info/10 text-info-foreground dark:bg-info/18",
              tone === "muted" && "bg-accent text-muted-foreground",
            )}
          >
            {roleIcon}
            {role}
          </span>
        </div>
        <p className="text-pretty text-muted-foreground text-xs leading-5">{does}</p>
      </div>
    </li>
  );
}
