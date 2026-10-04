// T3 Code's settings card surface (components/settings/SettingsGroup.tsx, MIT, see index.css).
import type * as React from "react";

import { cn } from "../../lib/utils";

export function Group({
  className,
  divided = true,
  ...props
}: React.ComponentProps<"div"> & { divided?: boolean }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5",
        divided && "[&>*+*]:border-t [&>*+*]:border-border/50",
        className,
      )}
      {...props}
    />
  );
}

/** A section title above a group, in T3's settings style. */
export function GroupLabel({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("mb-2 px-1 font-medium text-muted-foreground text-xs", className)}
      {...props}
    />
  );
}
