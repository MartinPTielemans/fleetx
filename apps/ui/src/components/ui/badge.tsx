// Adapted from T3 Code's components/ui/badge.tsx (MIT, see index.css).
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent font-medium [&_svg:not([class*='size-'])]:size-3 [&_svg]:shrink-0",
  {
    defaultVariants: { size: "default", variant: "secondary" },
    variants: {
      size: {
        default: "h-4.5 min-w-4.5 px-[calc(--spacing(1)-1px)] text-xs",
        lg: "h-5.5 min-w-5.5 px-[calc(--spacing(1.5)-1px)] text-sm",
      },
      variant: {
        default: "bg-primary text-primary-foreground",
        error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
        info: "bg-info/8 text-info-foreground dark:bg-info/16",
        outline: "border-input bg-background text-foreground dark:bg-input/32",
        secondary: "bg-accent text-secondary-foreground",
        success: "bg-success/8 text-success-foreground dark:bg-success/16",
        warning: "bg-warning/8 text-warning-foreground dark:bg-warning/16",
      },
    },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

export function Badge({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      className={cn(badgeVariants({ className, size, variant }))}
      data-slot="badge"
      {...props}
    />
  );
}
