"use client";
import { MAX_EXTENSION_DAYS, extensionLastDay } from "@jobflow/domain";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "@/components/operator/confirm-dialog";
import { formatDay } from "@/components/operator/format";
import { Button } from "@/components/ui/button";

const CONTROL =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";
const ALREADY = "This request was already decided by another operator.";

type Decision = "approve" | "decline";

/** Approve (days and a private note) or decline (a reason) — design §13b. */
export function DecisionForms({
  requestId,
  companyName,
  lastDay,
  today,
}: {
  requestId: string;
  companyName: string;
  lastDay: string;
  today: string;
}) {
  const router = useRouter();
  const [days, setDays] = useState("14");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ days?: string; reason?: string }>({});
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const count = Number(days);
  const validDays =
    /^\d+$/.test(days.trim()) && count >= 1 && count <= MAX_EXTENSION_DAYS;
  const newLastDay = validDays ? extensionLastDay(lastDay, today, count) : null;

  function open(decision: Decision, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (decision === "approve" && !validDays) {
      setErrors({
        days: `Enter a whole number of days from 1 to ${MAX_EXTENSION_DAYS}`,
      });
      return;
    }
    if (decision === "decline" && !reason.trim()) {
      setErrors({ reason: "Enter a reason" });
      return;
    }
    setErrors({});
    setConfirming(decision);
  }

  async function decide() {
    if (!confirming) return;
    setBusy(true);
    const response = await fetch(
      `/api/operator/extension-requests/${requestId}/${confirming}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          confirming === "approve"
            ? { days: count, ...(note.trim() ? { note: note.trim() } : {}) }
            : { reason: reason.trim() },
        ),
      },
    ).catch(() => undefined);
    setBusy(false);
    if (response?.ok) {
      setConfirming(null);
      router.refresh();
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      fields?: Record<string, string>;
    } | null;
    setError(
      response?.status === 409
        ? `${ALREADY} Reload the page to see the result.`
        : (Object.values(result?.fields ?? {})[0] ??
            result?.error ??
            "Something went wrong. Try again."),
    );
  }

  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <form
          noValidate
          onSubmit={(event) => open("approve", event)}
          aria-labelledby="approve-heading"
          className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
        >
          <h2 id="approve-heading" className="text-xl font-semibold">
            Approve
          </h2>
          <div className="flex flex-col gap-2">
            <label htmlFor="approve-days">Extend by (days)</label>
            <input
              id="approve-days"
              inputMode="numeric"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              aria-invalid={errors.days ? true : undefined}
              aria-describedby="approve-days-help approve-days-error"
              className={CONTROL}
            />
            <p
              id="approve-days-help"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {newLastDay
                ? `New last day: ${formatDay(newLastDay)}`
                : `1 to ${MAX_EXTENSION_DAYS} days`}
            </p>
            {errors.days ? (
              <p
                id="approve-days-error"
                role="alert"
                className="text-sm text-danger-foreground"
              >
                {errors.days}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="approve-note">Note (optional)</label>
            <textarea
              id="approve-note"
              rows={3}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-describedby="approve-note-help"
              className="rounded-sm border border-input bg-card p-3 text-card-foreground"
            />
            <p id="approve-note-help" className="text-sm text-muted-foreground">
              For the operator log only. The owner doesn&apos;t see it.
            </p>
          </div>
          <Button type="submit">Approve</Button>
        </form>
        <form
          noValidate
          onSubmit={(event) => open("decline", event)}
          aria-labelledby="decline-heading"
          className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
        >
          <h2 id="decline-heading" className="text-xl font-semibold">
            Decline
          </h2>
          <div className="flex flex-col gap-2">
            <label htmlFor="decline-reason">Reason</label>
            <textarea
              id="decline-reason"
              rows={3}
              maxLength={500}
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={errors.reason ? true : undefined}
              aria-describedby="decline-reason-help decline-reason-error"
              className="rounded-sm border border-input bg-card p-3 text-card-foreground"
            />
            <p
              id="decline-reason-help"
              className="text-sm text-muted-foreground"
            >
              The owner sees this reason.
            </p>
            {errors.reason ? (
              <p
                id="decline-reason-error"
                role="alert"
                className="text-sm text-danger-foreground"
              >
                {errors.reason}
              </p>
            ) : null}
          </div>
          <Button type="submit" variant="destructive">
            Decline
          </Button>
        </form>
      </div>
      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming === "approve"
            ? `Extend ${companyName} to ${formatDay(newLastDay)}?`
            : "Decline this request?"
        }
        confirmLabel={confirming === "approve" ? "Approve" : "Decline"}
        destructive={confirming === "decline"}
        busy={busy}
        error={error}
        onConfirm={() => void decide()}
        onClose={() => setConfirming(null)}
      >
        <p>
          {confirming === "approve"
            ? "The owner is emailed and sees the new last day."
            : "The owner is emailed with your reason."}
        </p>
      </ConfirmDialog>
    </>
  );
}
