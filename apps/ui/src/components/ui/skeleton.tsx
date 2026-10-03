// T3 Code's skeleton bar (components/ui/skeleton.tsx, MIT, see index.css).
import type * as React from "react";

import { cn } from "../../lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-sm bg-muted-foreground/15 motion-safe:animate-skeleton", className)} {...props} />;
}
