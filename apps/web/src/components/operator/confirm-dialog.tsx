"use client";
import { type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * A modal confirmation (design §13). Focus starts on Cancel, Escape closes,
 * and focus returns to whatever opened it.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busy,
  destructive,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  busy: boolean;
  destructive?: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      opener.current = document.activeElement;
      node.showModal();
      cancel.current?.focus();
    } else if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-heading"
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border bg-card p-6 text-card-foreground backdrop:bg-black/50"
      onClose={() => {
        onClose();
        if (opener.current instanceof HTMLElement) opener.current.focus();
      }}
    >
      <div className="space-y-4">
        <h2 id="confirm-heading" className="text-xl font-semibold">
          {title}
        </h2>
        {children}
        {error ? (
          <p
            role="alert"
            className="rounded-lg bg-danger p-3 text-danger-foreground"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            ref={cancel}
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
