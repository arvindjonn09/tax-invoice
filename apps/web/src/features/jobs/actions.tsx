"use client";
import { useState } from "react";
import { nextStatuses, transitionProblem } from "@jobflow/domain";
import {
  Field,
  TextField,
  FormMessage,
  sendJson,
} from "@/components/form/field";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { EntityPicker } from "./picker";
import { statusLabel, time, type Job, type Visit } from "./types";
type Message = { kind: "success" | "error"; text: string } | null;
export function StatusForm({ job, saved }: { job: Job; saved: () => void }) {
  const options = nextStatuses(job.status).filter(
    (value) => transitionProblem(job.status, value) === null,
  );
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useUnsavedChanges(dirty);
  if (!options.length)
    return <p className="text-muted-foreground">This job status is final.</p>;
  return (
    <form
      className="space-y-4"
      onChange={() => setDirty(true)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        const to = String(form.get("to"));
        if (
          ["closed", "cancelled"].includes(to) &&
          !window.confirm(
            `${statusLabel(to)}: ${job.reference}? History and actual costs are retained. This status cannot be reopened.`,
          )
        )
          return;
        setBusy(true);
        const result = await sendJson(`/api/jobs/${job.id}/status`, "POST", {
          to,
          note: String(form.get("note") ?? "").trim() || null,
        });
        setBusy(false);
        if (!result.ok) {
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        setMessage({ kind: "success", text: "Status updated." });
        saved();
      }}
    >
      <fieldset
        disabled={busy}
        className="grid items-start gap-4 sm:grid-cols-2"
      >
        <legend className="sr-only">Change job status</legend>
        <Field id="job-next-status" label="Next status">
          {(control) => (
            <select {...control} name="to" defaultValue={options[0]}>
              {options.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(value)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <TextField
          id="job-status-note"
          name="note"
          label="Status note"
          maxLength={500}
        />
      </fieldset>
      <FormMessage message={message} />
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Update status"}
      </Button>
    </form>
  );
}
/** Approve submitted work or send it back with a note (#42). */
export function ReviewForm({ job, saved }: { job: Job; saved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [noteError, setNoteError] = useState<string>();
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const decision =
          submitter?.getAttribute("value") === "rework" ? "rework" : "approve";
        const note =
          String(new FormData(event.currentTarget).get("note") ?? "").trim() ||
          null;
        if (decision === "rework" && !note) {
          setNoteError("Say what needs redoing");
          return;
        }
        setNoteError(undefined);
        setBusy(true);
        const result = await sendJson(`/api/jobs/${job.id}/review`, "POST", {
          decision,
          note,
        });
        setBusy(false);
        if (!result.ok) {
          setNoteError(result.fields.note);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setMessage(null);
        saved();
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        <legend className="sr-only">Review submitted work</legend>
        <TextField
          id="job-review-note"
          name="note"
          label="Review note"
          hint="Required when sending the work back"
          maxLength={500}
          error={noteError}
        />
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="decision" value="approve" disabled={busy}>
          {busy ? "Saving…" : "Approve completion"}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="rework"
          variant="outline"
          disabled={busy}
        >
          Request rework
        </Button>
      </div>
    </form>
  );
}
function localInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}
export function VisitEditor({
  jobId,
  initial,
  saved,
  cancel,
}: {
  jobId: string;
  initial?: Visit;
  saved: () => void;
  cancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useUnsavedChanges(dirty);
  return (
    <form
      className="space-y-4"
      onChange={() => setDirty(true)}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        const startText = String(form.get("startsAt"));
        const start = new Date(
          initial && startText === localInput(initial.startsAt)
            ? initial.startsAt
            : startText,
        );
        const endText = String(form.get("endsAt") ?? "");
        const end = endText
          ? new Date(
              initial?.endsAt && endText === localInput(initial.endsAt)
                ? initial.endsAt
                : endText,
            )
          : null;
        if (
          !Number.isFinite(start.getTime()) ||
          (end && (!Number.isFinite(end.getTime()) || end <= start))
        ) {
          setMessage({
            kind: "error",
            text: "Enter a valid start and an end after the start.",
          });
          return;
        }
        setBusy(true);
        const result = await sendJson(
          `/api/jobs/${jobId}/visits${initial ? `/${initial.id}` : ""}`,
          initial ? "PATCH" : "POST",
          {
            startsAt: start.toISOString(),
            endsAt: end?.toISOString() ?? null,
            status: form.get("status"),
            notes: String(form.get("notes") ?? "").trim() || null,
          },
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        saved();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Times use your browser&apos;s local timezone. Start is required.
      </p>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Visit details</legend>
        <TextField
          id="visit-start"
          name="startsAt"
          label="Visit start *"
          type="datetime-local"
          required
          defaultValue={localInput(initial?.startsAt)}
          error={errors.startsAt}
        />
        <TextField
          id="visit-end"
          name="endsAt"
          label="Visit end"
          type="datetime-local"
          defaultValue={localInput(initial?.endsAt)}
          error={errors.endsAt}
        />
        <Field id="visit-status" label="Visit status" error={errors.status}>
          {(control) => (
            <select
              {...control}
              name="status"
              defaultValue={initial?.status ?? "scheduled"}
            >
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          )}
        </Field>
        <Field
          id="visit-notes"
          label="Internal visit notes"
          error={errors.notes}
        >
          {(control) => (
            <textarea
              {...control}
              name="notes"
              rows={3}
              maxLength={1000}
              defaultValue={initial?.notes ?? ""}
              className={`${control.className} py-3`}
            />
          )}
        </Field>
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save visit"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved changes?")) cancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
export function VisitsPanel({
  job,
  editable,
  saved,
}: {
  job: Job;
  editable: boolean;
  saved: () => void;
}) {
  const [editor, setEditor] = useState<"new" | Visit | null>(null);
  const [message, setMessage] = useState<Message>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Visits</h2>
        {editable && !editor ? (
          <Button variant="outline" onClick={() => setEditor("new")}>
            Add visit
          </Button>
        ) : null}
      </div>
      <FormMessage message={message} />
      {editor ? (
        <VisitEditor
          key={editor === "new" ? editor : editor.id}
          jobId={job.id}
          {...(editor === "new" ? {} : { initial: editor })}
          cancel={() => setEditor(null)}
          saved={() => {
            setEditor(null);
            setMessage({ kind: "success", text: "Visit saved." });
            saved();
          }}
        />
      ) : null}
      {!job.visits?.length ? (
        <p className="text-muted-foreground">No visits scheduled.</p>
      ) : (
        <ul className="divide-y">
          {job.visits.map((visit) => (
            <li
              key={visit.id}
              className="flex flex-wrap items-start justify-between gap-3 py-4"
            >
              <div className="min-w-0 space-y-2 break-words">
                <h3 className="font-medium">{time(visit.startsAt)}</h3>
                <p>
                  {statusLabel(visit.status)}
                  {visit.endsAt ? ` · Ends ${time(visit.endsAt)}` : ""}
                </p>
                {visit.notes ? (
                  <p className="whitespace-pre-wrap">{visit.notes}</p>
                ) : null}
              </div>
              {editable && !editor ? (
                <Button variant="outline" onClick={() => setEditor(visit)}>
                  Edit visit
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export function AssignmentsPanel({
  job,
  editable,
  saved,
}: {
  job: Job;
  editable: boolean;
  saved: () => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [visitId, setVisitId] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useUnsavedChanges(dirty);
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Assignments</h2>
      <FormMessage message={message} />
      {editable ? (
        <form
          className="space-y-4"
          onChange={(event) => {
            if (!(event.target as Element).closest("[data-filter]"))
              setDirty(true);
          }}
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            const result = await sendJson(
              `/api/jobs/${job.id}/assignments`,
              "POST",
              { employeeId, visitId: visitId || null },
            );
            setBusy(false);
            if (!result.ok) {
              setErrors(result.fields);
              setMessage({ kind: "error", text: result.message });
              return;
            }
            setDirty(false);
            setEmployeeId("");
            setVisitId("");
            setErrors({});
            setMessage({ kind: "success", text: "Employee assigned." });
            saved();
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <legend className="sr-only">Assign an employee</legend>
            <EntityPicker
              kind="employees"
              id="assignment-employee"
              label="Employee *"
              value={employeeId}
              onChange={(id) => {
                setEmployeeId(id);
                setDirty(true);
              }}
              error={errors.employeeId}
            />
            <Field
              id="assignment-visit"
              label="Assignment scope"
              error={errors.visitId}
            >
              {(control) => (
                <select
                  {...control}
                  value={visitId}
                  onChange={(event) => setVisitId(event.target.value)}
                >
                  <option value="">Whole job</option>
                  {job.visits
                    ?.filter((visit) => visit.status !== "cancelled")
                    .map((visit) => (
                      <option key={visit.id} value={visit.id}>
                        {time(visit.startsAt)} · {statusLabel(visit.status)}
                      </option>
                    ))}
                </select>
              )}
            </Field>
          </fieldset>
          <Button type="submit" disabled={busy || !employeeId}>
            {busy ? "Saving…" : "Assign employee"}
          </Button>
        </form>
      ) : null}
      {!job.assignments?.length ? (
        <p className="text-muted-foreground">No employees assigned.</p>
      ) : (
        <ul className="divide-y">
          {job.assignments.map((assignment) => (
            <li
              key={assignment.id}
              className="flex flex-wrap items-center justify-between gap-3 py-4"
            >
              <div className="space-y-1">
                <h3 className="font-medium">{assignment.employeeName}</h3>
                <p className="text-sm text-muted-foreground">
                  {assignment.endedAt ? "Ended" : "Assigned"}
                  {!assignment.employeeActive
                    ? " · Employee inactive"
                    : ""} ·{" "}
                  {assignment.visitId
                    ? `Visit: ${job.visits?.find((visit) => visit.id === assignment.visitId) ? time(job.visits.find((visit) => visit.id === assignment.visitId)!.startsAt) : "Unavailable"}`
                    : "Whole job"}
                </p>
              </div>
              {editable && !assignment.endedAt ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `End ${assignment.employeeName}'s assignment? Their access through this assignment will end. History is retained.`,
                      )
                    )
                      return;
                    setBusy(true);
                    const result = await sendJson(
                      `/api/jobs/${job.id}/assignments/${assignment.id}`,
                      "PATCH",
                      { ended: true },
                    );
                    setBusy(false);
                    setMessage(
                      result.ok
                        ? { kind: "success", text: "Assignment ended." }
                        : { kind: "error", text: result.message },
                    );
                    if (result.ok) saved();
                  }}
                >
                  End assignment
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
