"use client";
import { validateDirectExtension } from "@jobflow/domain";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "@/components/operator/confirm-dialog";
import { formatDay } from "@/components/operator/format";
import { Button } from "@/components/ui/button";
import { useFocusWhen } from "@/lib/focus";

const CONTROL =
  "min-h-11 rounded-sm border border-input bg-card px-4 text-card-foreground";
const AREA = "rounded-sm border border-input bg-card p-3 text-card-foreground";
const CARD = "space-y-4 rounded-lg border bg-card p-6 text-card-foreground";
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const EXTEND_ERRORS = {
  not_later: "Choose a later day than the current last day",
  before_today: "Choose today or later",
  too_far: "Choose a day within a year",
} as const;

type Action =
  | { kind: "extend"; lastDay: string; reason: string }
  | {
      kind: "access";
      mode: "trial" | "unrestricted";
      lastDay: string;
      reason: string;
    };

function FieldError({
  id,
  message,
}: {
  id: string;
  message?: string | undefined;
}) {
  return message ? (
    <p id={id} className="text-sm text-danger-foreground">
      {message}
    </p>
  ) : null;
}

/** "Extend trial" and "Change access", each with a reason and a confirm. */
export function CompanyForms({
  companyId,
  companyName,
  mode,
  lastDay,
  today,
}: {
  companyId: string;
  companyName: string;
  mode: "trial" | "unrestricted";
  lastDay: string | null;
  today: string;
}) {
  const router = useRouter();
  const [extendDay, setExtendDay] = useState("");
  const [extendReason, setExtendReason] = useState("");
  const [nextMode, setNextMode] = useState<"trial" | "unrestricted">(
    mode === "trial" ? "unrestricted" : "trial",
  );
  const [accessDay, setAccessDay] = useState("");
  const [accessReason, setAccessReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const doneRef = useFocusWhen<HTMLParagraphElement>(done);

  function reasonError(reason: string) {
    return reason.trim() ? undefined : "Enter a reason";
  }

  function openExtend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!DAY.test(extendDay)) found.extendDay = "Choose the new last day";
    else if (lastDay) {
      const check = validateDirectExtension(lastDay, extendDay, today);
      if (!check.ok) found.extendDay = EXTEND_ERRORS[check.reason];
    }
    const reason = reasonError(extendReason);
    if (reason) found.extendReason = reason;
    setErrors(found);
    setError(null);
    if (Object.keys(found).length === 0)
      setAction({
        kind: "extend",
        lastDay: extendDay,
        reason: extendReason.trim(),
      });
  }

  function openAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (nextMode === mode)
      found.accessMode =
        mode === "trial"
          ? "It's already on a trial"
          : "It's already unrestricted";
    if (nextMode === "trial") {
      if (!DAY.test(accessDay)) found.accessDay = "Choose the trial's last day";
      else if (accessDay < today) found.accessDay = "Choose today or later";
    }
    const reason = reasonError(accessReason);
    if (reason) found.accessReason = reason;
    setErrors(found);
    setError(null);
    if (Object.keys(found).length === 0)
      setAction({
        kind: "access",
        mode: nextMode,
        lastDay: accessDay,
        reason: accessReason.trim(),
      });
  }

  async function confirm() {
    if (!action) return;
    setBusy(true);
    const response = await fetch(
      `/api/operator/companies/${companyId}/${action.kind}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action.kind === "extend"
            ? { lastDay: action.lastDay, reason: action.reason }
            : action.mode === "trial"
              ? {
                  mode: "trial",
                  lastDay: action.lastDay,
                  reason: action.reason,
                }
              : { mode: "unrestricted", reason: action.reason },
        ),
      },
    ).catch(() => undefined);
    setBusy(false);
    if (response?.ok) {
      setAction(null);
      setDone(
        action.kind === "extend"
          ? `Trial extended to ${formatDay(action.lastDay)}.`
          : action.mode === "trial"
            ? `Now on a trial until ${formatDay(action.lastDay)}.`
            : "Access is now unrestricted.",
      );
      router.refresh();
      return;
    }
    const result = (await response?.json().catch(() => null)) as {
      error?: string;
      fields?: Record<string, string>;
    } | null;
    setError(
      Object.values(result?.fields ?? {})[0] ??
        result?.error ??
        "Something went wrong. Try again.",
    );
  }

  const title = !action
    ? ""
    : action.kind === "extend"
      ? `Extend ${companyName} to ${formatDay(action.lastDay)}?`
      : action.mode === "trial"
        ? `Put ${companyName} on a trial until ${formatDay(action.lastDay)}?`
        : `Make ${companyName} unrestricted?`;

  return (
    <>
      {done ? (
        <p
          role="status"
          ref={doneRef}
          tabIndex={-1}
          className="rounded-lg bg-success p-4 text-success-foreground"
        >
          {done}
        </p>
      ) : null}
      <div className="grid gap-6 md:grid-cols-2">
        {mode === "trial" ? (
          <form
            noValidate
            onSubmit={openExtend}
            aria-labelledby="extend-heading"
            className={CARD}
          >
            <h2 id="extend-heading" className="text-xl font-semibold">
              Extend trial
            </h2>
            <div className="flex flex-col gap-2">
              <label htmlFor="extend-day">New last day</label>
              <input
                id="extend-day"
                type="date"
                value={extendDay}
                onChange={(event) => setExtendDay(event.target.value)}
                aria-invalid={errors.extendDay ? true : undefined}
                aria-describedby="extend-day-error"
                className={CONTROL}
              />
              <FieldError id="extend-day-error" message={errors.extendDay} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="extend-reason">Reason</label>
              <textarea
                id="extend-reason"
                rows={3}
                maxLength={500}
                value={extendReason}
                onChange={(event) => setExtendReason(event.target.value)}
                aria-invalid={errors.extendReason ? true : undefined}
                aria-describedby="extend-reason-error"
                className={AREA}
              />
              <FieldError
                id="extend-reason-error"
                message={errors.extendReason}
              />
            </div>
            <Button type="submit">Extend trial</Button>
          </form>
        ) : null}
        <form
          noValidate
          onSubmit={openAccess}
          aria-labelledby="access-heading"
          className={CARD}
        >
          <h2 id="access-heading" className="text-xl font-semibold">
            Change access
          </h2>
          <fieldset className="space-y-3" aria-describedby="access-mode-error">
            <legend className="mb-2">Access</legend>
            {(
              [
                ["trial", "Trial"],
                ["unrestricted", "Unrestricted"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-3">
                <input
                  type="radio"
                  name="access-mode"
                  className="size-5"
                  checked={nextMode === value}
                  onChange={() => setNextMode(value)}
                />
                {label}
              </label>
            ))}
            <FieldError id="access-mode-error" message={errors.accessMode} />
          </fieldset>
          {nextMode === "trial" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="access-day">Trial last day</label>
              <input
                id="access-day"
                type="date"
                value={accessDay}
                onChange={(event) => setAccessDay(event.target.value)}
                aria-invalid={errors.accessDay ? true : undefined}
                aria-describedby="access-day-error"
                className={CONTROL}
              />
              <FieldError id="access-day-error" message={errors.accessDay} />
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <label htmlFor="access-reason">Reason</label>
            <textarea
              id="access-reason"
              rows={3}
              maxLength={500}
              value={accessReason}
              onChange={(event) => setAccessReason(event.target.value)}
              aria-invalid={errors.accessReason ? true : undefined}
              aria-describedby="access-reason-error"
              className={AREA}
            />
            <FieldError
              id="access-reason-error"
              message={errors.accessReason}
            />
          </div>
          <Button type="submit">Change access</Button>
        </form>
      </div>
      <ConfirmDialog
        open={action !== null}
        title={title}
        confirmLabel={
          action?.kind === "extend" ? "Extend trial" : "Change access"
        }
        busy={busy}
        error={error}
        onConfirm={() => void confirm()}
        onClose={() => setAction(null)}
      >
        <p>The owner is emailed about this change.</p>
      </ConfirmDialog>
    </>
  );
}
