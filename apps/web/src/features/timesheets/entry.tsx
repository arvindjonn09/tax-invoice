"use client";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { time } from "@/features/jobs/types";
import {
  duration,
  type JobOption,
  type OwnTimesheet,
  type VisitOption,
} from "./types";
/** Today in Sydney as YYYY-MM-DD, the server's "not in the future" bound. */
function sydneyToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
  }).format(new Date());
}
/** Whole hours and minutes → total minutes, or an error message. */
function totalMinutes(hours: string, minutes: string): number | string {
  const h = hours.trim() === "" ? 0 : Number(hours);
  const m = minutes.trim() === "" ? 0 : Number(minutes);
  if (!Number.isInteger(h) || h < 0 || h > 24) return "Hours must be 0–24";
  if (!Number.isInteger(m) || m < 0 || m > 59) return "Minutes must be 0–59";
  const total = h * 60 + m;
  if (total < 1) return "Enter at least 1 minute";
  if (total > 1440) return "At most 24 hours per timesheet";
  return total;
}
/**
 * Log time on an assigned job (optionally one of its visits), or edit an
 * entry until it's decided. Mobile-first: one column, native controls.
 */
export function TimesheetEntry({
  jobs,
  initial,
  onSaved,
  onCancel,
}: {
  jobs: JobOption[];
  initial?: OwnTimesheet;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const today = sydneyToday();
  const [jobId, setJobId] = useState(initial?.jobId ?? jobs[0]?.id ?? "");
  const [visitId, setVisitId] = useState(initial?.visitId ?? "");
  const [hours, setHours] = useState(
    initial ? String(Math.floor(initial.minutes / 60)) : "",
  );
  const [mins, setMins] = useState(initial ? String(initial.minutes % 60) : "");
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  useUnsavedChanges(dirty);
  const clearDurationError = () =>
    setErrors((previous) => {
      const next = { ...previous };
      delete next.minutes;
      return next;
    });
  const job = useRemote<{ visits: VisitOption[] }>(
    jobId ? `/api/my/jobs/${jobId}` : null,
  );
  const visits = (job.data?.visits ?? []).filter(
    (visit) => visit.status !== "cancelled",
  );
  const total = totalMinutes(hours, mins);
  const id = (name: string) => `timesheet-${initial?.id ?? "new"}-${name}`;
  return (
    <form
      className="space-y-4"
      noValidate
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const element = e.currentTarget,
          form = new FormData(element);
        setMessage(null);
        if (typeof total === "string") {
          setErrors({ minutes: total });
          return;
        }
        setErrors({});
        setBusy(true);
        const note = String(form.get("note") ?? "").trim() || null;
        const result = await sendJson(
          initial ? `/api/timesheets/${initial.id}` : "/api/timesheets",
          initial ? "PATCH" : "POST",
          {
            ...(initial ? {} : { jobId }),
            visitId: visitId || null,
            workDate: form.get("workDate"),
            minutes: total,
            note,
          },
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        if (!initial) {
          setHours("");
          setMins("");
          element.reset();
        }
        onSaved();
      }}
    >
      <fieldset className="space-y-4" disabled={busy}>
        <legend className="sr-only">
          {initial ? "Edit time" : "Log time"}
        </legend>
        <Field
          id={id("job")}
          label="Job *"
          error={errors.jobId}
          {...(jobs.length === 0
            ? { hint: "You need an assigned job before you can log time." }
            : {})}
        >
          {(control) => (
            <select
              {...control}
              name="jobId"
              value={jobId}
              disabled={Boolean(initial)}
              onChange={(e) => {
                setJobId(e.target.value);
                setVisitId("");
              }}
            >
              {jobs.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.reference} · {option.title}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id={id("visit")}
          label="Visit"
          error={errors.visitId}
          hint={
            job.error
              ? "Couldn't load this job's visits."
              : "Choose the visit if you were assigned to one."
          }
        >
          {(control) => (
            <select
              {...control}
              name="visitId"
              value={visitId}
              onChange={(e) => setVisitId(e.target.value)}
            >
              <option value="">Whole job</option>
              {visits.map((visit) => (
                <option key={visit.id} value={visit.id}>
                  {time(visit.startsAt)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={id("date")} label="Work date *" error={errors.workDate}>
          {(control) => (
            <input
              {...control}
              type="date"
              name="workDate"
              max={today}
              defaultValue={initial?.workDate ?? today}
            />
          )}
        </Field>
        <fieldset className="space-y-2">
          <legend className="font-medium">Time worked *</legend>
          <div className="grid grid-cols-2 gap-4">
            <Field id={id("hours")} label="Hours">
              {(control) => (
                <input
                  {...control}
                  inputMode="numeric"
                  value={hours}
                  aria-invalid={Boolean(errors.minutes)}
                  onChange={(e) => {
                    setHours(e.target.value);
                    clearDurationError();
                  }}
                />
              )}
            </Field>
            <Field id={id("minutes")} label="Minutes">
              {(control) => (
                <input
                  {...control}
                  inputMode="numeric"
                  value={mins}
                  aria-invalid={Boolean(errors.minutes)}
                  onChange={(e) => {
                    setMins(e.target.value);
                    clearDurationError();
                  }}
                />
              )}
            </Field>
          </div>
          {errors.minutes ? (
            <p role="alert" className="text-sm text-danger-foreground">
              {errors.minutes}
            </p>
          ) : typeof total === "number" ? (
            <p className="text-sm text-muted-foreground">
              Total {duration(total)}
            </p>
          ) : null}
        </fieldset>
        <Field id={id("note")} label="Note" error={errors.note}>
          {(control) => (
            <textarea
              {...control}
              className={`${control.className} min-h-20 py-3`}
              name="note"
              maxLength={500}
              defaultValue={initial?.note ?? ""}
            />
          )}
        </Field>
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || jobs.length === 0}>
          {busy ? "Saving…" : initial ? "Save changes" : "Log time"}
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm("Discard unsaved changes?")) {
                setDirty(false);
                onCancel();
              }
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
