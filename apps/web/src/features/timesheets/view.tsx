"use client";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { PageHeader } from "@/components/shell/page-header";
import { formatAudCents } from "@/components/money-display";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { day } from "@/features/jobs/types";
import { TimesheetEntry } from "./entry";
import {
  STATUS_LABELS,
  duration,
  type JobOption,
  type OfficeTimesheet,
  type OwnTimesheet,
} from "./types";
type Page<T> = { timesheets: T[]; total: number; pageSize: number };
type Message = { kind: "success" | "error"; text: string } | null;
/**
 * Employees log time on assigned jobs and see only their own entries (no
 * rate or cost). Approvers work the queue; rate and cost show only with
 * employee.cost_rate.read.
 */
export function TimesheetsView({
  office,
  showCost,
}: {
  office: boolean;
  showCost: boolean;
}) {
  const [status, setStatus] = useState(office ? "submitted" : "");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const params = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(office && status ? { status } : {}),
  });
  const { data, error, reload } = useRemote<
    Page<OfficeTimesheet | OwnTimesheet>
  >(`${office ? "/api/timesheets" : "/api/my/timesheets"}?${params}`);
  const jobsData = useRemote<{ jobs: JobOption[] }>(
    office ? "/api/jobs?pageSize=100" : "/api/my/jobs?pageSize=100",
  );
  const jobs = jobsData.data?.jobs ?? [];
  const jobLabel = (jobId: string) => {
    const job = jobs.find((row) => row.id === jobId);
    return job ? `${job.reference} · ${job.title}` : "Job";
  };
  const saved = (text: string) => {
    setEditing(null);
    setMessage({ kind: "success", text });
    reload();
  };
  return (
    <>
      <PageHeader
        title={office ? "Timesheets" : "My time"}
        description={
          office
            ? "Approve logged hours. Approval fixes the labour cost once."
            : "Log hours on your assigned jobs. The office approves them."
        }
      />
      {!office ? (
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">Log time</h2>
          {jobsData.error ? (
            <div role="alert" className="space-y-3">
              <p>{jobsData.error}</p>
              <Button variant="outline" onClick={jobsData.reload}>
                Retry jobs
              </Button>
            </div>
          ) : !jobsData.data ? (
            <p role="status">Loading your jobs…</p>
          ) : (
            <TimesheetEntry
              jobs={jobs}
              onSaved={() => saved("Time logged for approval.")}
            />
          )}
        </section>
      ) : (
        <div className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
          <Field id="timesheet-status" label="Show">
            {(control) => (
              <select
                {...control}
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="submitted">Awaiting approval</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="">All timesheets</option>
              </select>
            )}
          </Field>
        </div>
      )}
      <FormMessage message={message} />
      {error ? (
        <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : !data ? (
        <p role="status">Loading timesheets…</p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {data.total} {data.total === 1 ? "timesheet" : "timesheets"} · Page{" "}
            {page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          {data.timesheets.length === 0 ? (
            <div className="rounded-lg border bg-card p-8">
              <h2 className="text-xl font-semibold">
                {office && status === "submitted"
                  ? "Nothing awaiting approval"
                  : "No timesheets to show"}
              </h2>
              <p className="mt-2 text-muted-foreground">
                {office
                  ? "Logged hours appear here for approval."
                  : "Time you log appears here with its approval status."}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {data.timesheets.map((row) => (
                <li
                  key={row.id}
                  className="min-w-0 space-y-3 rounded-lg border bg-card p-4 [overflow-wrap:anywhere]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold">
                        {"employeeName" in row ? `${row.employeeName} · ` : ""}
                        {duration(row.minutes)} on {day(row.workDate)}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {jobLabel(row.jobId)}
                        {row.visitId ? " · Visit" : ""}
                        {row.reversesId ? " · Reversal" : ""}
                      </p>
                    </div>
                    <span className="rounded-sm bg-muted px-2 py-1 text-sm">
                      {STATUS_LABELS[row.status]}
                    </span>
                  </div>
                  {row.note ? (
                    <p className="whitespace-pre-wrap">{row.note}</p>
                  ) : null}
                  {showCost &&
                  "costCents" in row &&
                  row.costCents != null &&
                  row.hourlyCostCents != null ? (
                    <p className="money text-sm">
                      Labour cost {formatAudCents(BigInt(row.costCents))} AUD at{" "}
                      {formatAudCents(BigInt(row.hourlyCostCents))}/h (fixed on
                      approval)
                    </p>
                  ) : null}
                  {row.decisionNote ? (
                    <p className="text-sm">Note: {row.decisionNote}</p>
                  ) : null}
                  {!office && row.status === "submitted" && !row.reversesId ? (
                    editing === row.id ? (
                      <TimesheetEntry
                        jobs={jobs}
                        initial={row}
                        onCancel={() => setEditing(null)}
                        onSaved={() => saved("Timesheet updated.")}
                      />
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setMessage(null);
                          setEditing(row.id);
                        }}
                      >
                        Edit time
                      </Button>
                    )
                  ) : null}
                  {office && row.status === "submitted" ? (
                    <Decide id={row.id} onDone={saved} />
                  ) : null}
                  {office &&
                  row.status === "approved" &&
                  !row.reversesId &&
                  "reversedById" in row &&
                  !row.reversedById ? (
                    <Reverse id={row.id} onDone={saved} />
                  ) : null}
                  {"reversedById" in row && row.reversedById ? (
                    <p className="text-sm">Reversed.</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Timesheet pages" className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={page === 1}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={page * data.pageSize >= data.total}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </Button>
          </nav>
        </>
      )}
    </>
  );
}
function Decide({
  id,
  onDone,
}: {
  id: string;
  onDone: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  return (
    <form
      className="space-y-3 border-t pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const submitter = (e.nativeEvent as SubmitEvent)
          .submitter as HTMLButtonElement | null;
        const decision = submitter?.value === "reject" ? "reject" : "approve";
        const form = new FormData(e.currentTarget);
        setBusy(true);
        const result = await sendJson(
          `/api/timesheets/${id}/decision`,
          "POST",
          {
            decision,
            note: String(form.get("note") ?? "").trim() || null,
          },
        );
        setBusy(false);
        if (!result.ok) {
          setMessage({ kind: "error", text: result.message });
          return;
        }
        onDone(
          decision === "approve"
            ? "Timesheet approved."
            : "Timesheet rejected.",
        );
      }}
    >
      <Field id={`decision-note-${id}`} label="Decision note">
        {(control) => (
          <input {...control} name="note" maxLength={500} disabled={busy} />
        )}
      </Field>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="decision" value="approve" disabled={busy}>
          Approve
        </Button>
        <Button
          type="submit"
          name="decision"
          value="reject"
          variant="outline"
          disabled={busy}
        >
          Reject
        </Button>
      </div>
    </form>
  );
}
function Reverse({
  id,
  onDone,
}: {
  id: string;
  onDone: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Reverse timesheet
      </Button>
    );
  return (
    <form
      className="space-y-3 border-t pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = new FormData(e.currentTarget);
        if (
          !window.confirm(
            "Reverse this approved timesheet? A reversal with negated hours and cost is recorded; the original is kept.",
          )
        )
          return;
        setBusy(true);
        const result = await sendJson(
          `/api/timesheets/${id}/reversal`,
          "POST",
          {
            note: String(form.get("note") ?? ""),
          },
        );
        setBusy(false);
        if (!result.ok) {
          setMessage({ kind: "error", text: result.message });
          return;
        }
        onDone("Timesheet reversed.");
      }}
    >
      <Field id={`reverse-note-${id}`} label="Reason for reversal *">
        {(control) => (
          <input {...control} name="note" maxLength={500} disabled={busy} />
        )}
      </Field>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" variant="destructive" disabled={busy}>
          Confirm reversal
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
