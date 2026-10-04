/** The dialogs every view uses: a frame that stays open while something runs, and a confirmation built on it. */
import type * as React from "react";

import { useAction } from "../lib/store";
import { Spinner } from "./ui/spinner";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button, type ButtonProps } from "./ui/button";

export function Failure({ error }: { error: unknown }) {
  if (error === null) return null;
  return (
    <div
      role="alert"
      className="whitespace-pre-wrap break-words rounded-lg border border-destructive/30 bg-error-surface px-3 py-2 text-destructive-foreground text-xs"
    >
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/** A dialog that cannot be closed while `busy`, so nobody loses sight of what runs. */
export function ActionDialog({
  open,
  busy,
  onClose,
  className,
  children,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  className?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <AlertDialogPopup className={className}>{children}</AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Ask, run `onConfirm`, then close; or, with `done`, show what it did until
 * the user closes it. Its error stays in the dialog.
 */
export function ConfirmDialog<T>({
  open,
  title,
  description,
  confirm,
  icon,
  variant = "default",
  onConfirm,
  onClose,
  onDone,
  done,
  disabled = false,
  className,
  children,
}: {
  open: boolean;
  title: React.ReactNode;
  description: React.ReactNode;
  confirm: string;
  icon?: React.ReactNode;
  variant?: ButtonProps["variant"];
  onConfirm: () => Promise<T>;
  onClose: () => void;
  onDone?: (result: T) => void;
  /** What it did, shown in place of the question; without it the dialog closes on success. */
  done?: (result: T) => React.ReactNode;
  /** Whether confirming is refused, for a reason the children say. */
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const action = useAction(onConfirm);
  const close = () => {
    action.reset();
    onClose();
  };
  const run = async () => {
    const result = await action.start();
    if (result === null) return;
    onDone?.(result);
    if (done === undefined) close();
  };
  const result = done === undefined ? null : action.result;
  return (
    <ActionDialog open={open} busy={action.running} onClose={close} className={className}>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {children === undefined && result === null && action.error === null ? null : (
        <AlertDialogBody className="flex flex-col gap-3">
          {result === null ? children : done?.(result)}
          <Failure error={action.error} />
        </AlertDialogBody>
      )}
      <AlertDialogFooter>
        {result !== null ? (
          <AlertDialogClose render={<Button />}>Done</AlertDialogClose>
        ) : (
          <>
            <AlertDialogClose render={<Button variant="ghost" disabled={action.running} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant={variant}
              disabled={action.running || disabled}
              onClick={() => void run()}
            >
              {action.running ? <Spinner className="size-3.5" /> : icon}
              {confirm}
            </Button>
          </>
        )}
      </AlertDialogFooter>
    </ActionDialog>
  );
}
