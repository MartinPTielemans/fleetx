// Adapted from T3 Code's components/ui/alert-dialog.tsx and dialog-styles.ts (MIT, see index.css).
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type * as React from "react";

import { cn } from "../../lib/utils";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogClose = AlertDialogPrimitive.Close;

export function AlertDialogPopup({ className, ...props }: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <AlertDialogPrimitive.Viewport className="fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4">
        <AlertDialogPrimitive.Popup
          className={cn(
            "dialog-glass relative row-start-2 flex max-h-full w-full max-w-lg min-w-0 flex-col rounded-2xl border text-popover-foreground outline-none transition-[scale,opacity] duration-200 ease-in-out data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        />
      </AlertDialogPrimitive.Viewport>
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2 p-6 pb-4", className)} {...props} />;
}

export function AlertDialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-h-0 overflow-y-auto px-6 pb-4", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 px-6 py-4 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return <AlertDialogPrimitive.Title className={cn("font-semibold text-lg leading-none", className)} {...props} />;
}

export function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return <AlertDialogPrimitive.Description className={cn("text-muted-foreground text-sm", className)} {...props} />;
}
