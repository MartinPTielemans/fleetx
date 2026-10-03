import { LoaderCircleIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/utils";

export function Spinner({ className, ...props }: React.ComponentProps<typeof LoaderCircleIcon>) {
  return <LoaderCircleIcon aria-label="Loading" className={cn("size-4 motion-safe:animate-spin", className)} role="status" {...props} />;
}
