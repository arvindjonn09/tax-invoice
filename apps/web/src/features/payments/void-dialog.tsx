"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, sendJson } from "@/components/form/field";

/**
 * Void a recorded bill, payment or receipt with a reason. Records are never
 * edited or deleted; voiding keeps the original and its audit trail.
 */
export function VoidButton({
  url,
  label,
  consequence,
  onVoided,
}: {
  url: string;
  label: string;
  consequence: string;
  onVoided: (body: unknown) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        ref={opener}
        variant="outline"
        onClick={() => {
          setError(null);
          dialog.current?.showModal();
          cancel.current?.focus();
        }}
      >
        Void {label}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby="void-heading"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border bg-card p-6 text-card-foreground backdrop:bg-black/50"
        onClose={() => opener.current?.focus()}
      >
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            const result = await sendJson(url, "POST", {
              reason: reason.trim(),
            });
            setBusy(false);
            if (!result.ok) {
              setError(result.fields.reason ?? result.message);
              return;
            }
            dialog.current?.close();
            setReason("");
            onVoided(result.body);
          }}
        >
          <h2 id="void-heading" className="text-xl font-semibold">
            Void this {label}?
          </h2>
          <p>
            {consequence} It stays on record marked void; this can’t be undone.
          </p>
          <Field
            id="void-reason"
            label="Reason (required)"
            error={error ?? undefined}
          >
            {(control) => (
              <textarea
                {...control}
                className={`${control.className} min-h-20 py-3`}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
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
            <Button type="submit" disabled={busy}>
              {busy ? "Voiding…" : `Void ${label}`}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
