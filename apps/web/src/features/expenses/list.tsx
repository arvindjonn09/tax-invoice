"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useRemote } from "@/components/data/use-remote";
import { PageHeader } from "@/components/shell/page-header";
import { Field, FormMessage } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { day } from "@/features/jobs/types";
import { GstBreakdown, savedAmounts } from "./breakdown";
import { ExpenseForm } from "./form";
import {
  CATEGORY_LABELS,
  STATUS_LABELS,
  type JobOption,
  type OfficeExpense,
  type OwnExpense,
} from "./types";
type Page<T> = { expenses: T[]; total: number; pageSize: number };
/**
 * Office staff see every company expense, opening on the approval queue.
 * Employees see only their own submissions (no cost or credit split) and
 * can edit one until it's decided.
 */
export function ExpensesList({
  office,
  canApprove,
  canSubmit,
}: {
  office: boolean;
  canApprove: boolean;
  /** Accountants read the office list but can't submit (no upload either). */
  canSubmit: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState(canApprove ? "submitted" : "");
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const params = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(office && status ? { status } : {}),
  });
  const { data, error, reload } = useRemote<Page<OfficeExpense | OwnExpense>>(
    `${office ? "/api/expenses" : "/api/my/expenses"}?${params}`,
  );
  const jobsData = useRemote<{ jobs: JobOption[] }>(
    office ? "/api/jobs?pageSize=100" : "/api/my/jobs?pageSize=100",
  );
  const jobs = jobsData.data?.jobs ?? [];
  const jobLabel = (jobId: string | null) => {
    if (!jobId) return "General expense";
    const job = jobs.find((row) => row.id === jobId);
    return job ? `${job.reference} · ${job.title}` : "Job";
  };
  const form = (initial?: OwnExpense) =>
    jobsData.error ? (
      <div role="alert" className="space-y-3">
        <p>{jobsData.error}</p>
        <Button variant="outline" onClick={jobsData.reload}>
          Retry jobs
        </Button>
      </div>
    ) : !jobsData.data ? (
      <p role="status">Loading your jobs…</p>
    ) : (
      <ExpenseForm
        jobs={jobs}
        office={office}
        {...(initial ? { initial } : {})}
        onCancel={() => (initial ? setEditing(null) : setCreating(false))}
        onSaved={(saved) => {
          setCreating(false);
          setEditing(null);
          setMessage({
            kind: "success",
            text: initial
              ? "Expense updated."
              : "Expense submitted for approval.",
          });
          if (office && !initial) router.push(`/expenses/${saved.id}`);
          else reload();
        }}
      />
    );
  return (
    <>
      <PageHeader
        title={office ? "Expenses" : "My expenses"}
        description={
          office
            ? "Job and general expenses with their GST, approval and settlement."
            : "Claim purchases for your assigned jobs. The office approves them."
        }
        actions={
          creating || !canSubmit ? null : (
            <Button
              onClick={() => {
                setMessage(null);
                setCreating(true);
              }}
            >
              New expense
            </Button>
          )
        }
      />
      {creating && canSubmit ? (
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">New expense</h2>
          {form()}
        </section>
      ) : null}
      <FormMessage message={message} />
      {office ? (
        <div className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
          <Field id="expense-status" label="Show">
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
                <option value="">All expenses</option>
              </select>
            )}
          </Field>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
          <p>{error}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : !data ? (
        <p role="status">Loading expenses…</p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {data.total} {data.total === 1 ? "expense" : "expenses"} · Page{" "}
            {page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </p>
          {data.expenses.length === 0 ? (
            <div className="rounded-lg border bg-card p-8">
              <h2 className="text-xl font-semibold">
                {office && status === "submitted"
                  ? "Nothing awaiting approval"
                  : "No expenses to show"}
              </h2>
              <p className="mt-2 text-muted-foreground">
                {office
                  ? "Submitted expenses appear here for approval."
                  : "Expenses you submit appear here with their approval status."}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {data.expenses.map((expense) => (
                <li
                  key={expense.id}
                  className="min-w-0 space-y-3 rounded-lg border bg-card p-4 [overflow-wrap:anywhere]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold">
                        {office ? (
                          <Link
                            className="inline-flex min-h-11 items-center underline"
                            href={`/expenses/${expense.id}`}
                          >
                            {expense.description}
                          </Link>
                        ) : (
                          expense.description
                        )}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {CATEGORY_LABELS[expense.category] ?? expense.category}{" "}
                        · {day(expense.purchasedOn)} · {jobLabel(expense.jobId)}
                        {expense.supplierName
                          ? ` · ${expense.supplierName}`
                          : ""}
                        {expense.reversesId ? " · Reversal" : ""}
                      </p>
                    </div>
                    <span className="rounded-sm bg-muted px-2 py-1 text-sm">
                      {STATUS_LABELS[expense.status]}
                    </span>
                  </div>
                  <GstBreakdown
                    amounts={savedAmounts(expense)}
                    label={`GST breakdown for ${expense.description}`}
                  />
                  {expense.decisionNote ? (
                    <p className="text-sm">Note: {expense.decisionNote}</p>
                  ) : null}
                  {!office && expense.status === "submitted" ? (
                    editing === expense.id ? (
                      form(expense)
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setMessage(null);
                          setEditing(expense.id);
                        }}
                      >
                        Edit expense
                      </Button>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Expense pages" className="flex flex-wrap gap-3">
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
