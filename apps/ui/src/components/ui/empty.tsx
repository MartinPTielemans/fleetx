// Adapted from T3 Code's components/ui/empty.tsx (MIT, see index.css).
import type * as React from "react";

import { cn } from "../../lib/utils";

export function Empty({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-56 flex-col items-center justify-center gap-4 p-8 text-balance text-center",
        className,
      )}
    >
      {icon === undefined ? null : (
        <div className="relative flex size-9 items-center justify-center rounded-md border bg-card text-foreground shadow-sm/5 [&_svg]:size-4.5">
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col items-center gap-1.5">
        <div className="font-medium text-[0.9375rem]">{title}</div>
        {children === undefined ? null : (
          <div className="text-muted-foreground text-[0.8125rem] leading-[1.125rem]">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
