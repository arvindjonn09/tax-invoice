"use client";
import Link from "next/link";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { PageHeader } from "@/components/shell/page-header";
import { formatAudCents } from "@/components/money-display";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { day, time } from "@/features/jobs/types";
import { GstBreakdown, savedAmounts } from "./breakdown";
import { ExpenseForm } from "./form";
import {
  CATEGORY_LABELS,
  PAYMENT_LABELS,
  STATUS_LABELS,
  TAX_CODE_LABELS,
  type JobOption,
  type OfficeExpense,
} from "./types";
type Message = { kind: "success" | "error"; text: string } | null;
const aud = (cents: string) => `${formatAudCents(BigInt(cents))} AUD`;
export function ExpenseDetail({
  id,
  userId,
  canApprove,
}: {
  id: string;
  userId: string;
  canApprove: boolean;
}) {
  const { data, error, reload } = useRemote<OfficeExpense>(
    `/api/expenses/${id}`,
  );
  const jobsData = useRemote<{ jobs: JobOption[] }>("/api/jobs?pageSize=100");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  );
  if (!data)
    return error ? (
      <div role="alert" className="space-y-3 rounded-lg border bg-card p-6">
        <p>{error}</p>
        <Button onClick={reload}>Try again</Button>
      </div>
    ) : (
      <p role="status">Loading expense…</p>
    );
  const job = jobsData.data?.jobs.find((row) => row.id === data.jobId);
  const own = data.submittedBy === userId;
  return (
    <>
      <PageHeader
        title={data.description}
        description={`${STATUS_LABELS[data.status]}${data.reversesId ? " · Reversal" : ""}`}
        breadcrumbs={[
          { label: "Expenses", href: "/expenses" },
          { label: data.description },
        ]}
      />
      {error ? (
        <div role="alert" className="space-y-3">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : null}
      <FormMessage message={message} />
      <section className="min-w-0 space-y-4 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]">
        <h2 className="text-xl font-semibold">Expense</h2>
        {editing && jobsData.data ? (
          <ExpenseForm
            jobs={jobsData.data.jobs}
            office
            initial={data}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setMessage({ kind: "success", text: "Expense updated." });
              reload();
            }}
          />
        ) : (
          <>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">Job</dt>
                <dd>
                  {data.jobId ? (
                    <Link className="underline" href={`/jobs/${data.jobId}`}>
                      {job ? `${job.reference} · ${job.title}` : "Open job"}
                    </Link>
                  ) : (
                    "General expense"
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Category</dt>
                <dd>{CATEGORY_LABELS[data.category] ?? data.category}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Supplier</dt>
                <dd>{data.supplierName ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Purchased</dt>
                <dd>{day(data.purchasedOn)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">GST treatment</dt>
                <dd>
                  {TAX_CODE_LABELS[data.taxCode]} · entered{" "}
                  {data.priceEntry === "inclusive" ? "incl GST" : "ex GST"} ·{" "}
                  {data.creditablePercent}% business use
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Settlement</dt>
                <dd>
                  {data.settlement === "paid_at_purchase"
                    ? `Paid ${day(data.paidOn ?? data.purchasedOn)}${data.paymentMethod ? ` by ${PAYMENT_LABELS[data.paymentMethod].toLowerCase()}` : ""}`
                    : "On account (owed to the supplier)"}
                </dd>
              </div>
            </dl>
            <GstBreakdown amounts={savedAmounts(data)} />
            {data.receiptDocumentId ? (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const result = await sendJson(
                      `/api/documents/${data.receiptDocumentId}/link`,
                      "POST",
                      {},
                    );
                    if (!result.ok)
                      setMessage({ kind: "error", text: result.message });
                    else
                      setLink(
                        result.body as { url: string; expiresAt: string },
                      );
                  }}
                >
                  Create receipt link
                </Button>
                {link ? (
                  <p>
                    <a
                      className="inline-flex min-h-11 items-center underline"
                      href={link.url}
                    >
                      Open receipt
                    </a>{" "}
                    · expires {time(link.expiresAt)}
                  </p>
                ) : null}
              </div>
            ) : (
              <p>No receipt attached.</p>
            )}
            {own && data.status === "submitted" && !data.correctsId ? (
              <Button
                variant="outline"
                disabled={!jobsData.data}
                onClick={() => {
                  setMessage(null);
                  setEditing(true);
                }}
              >
                Edit expense
              </Button>
            ) : null}
          </>
        )}
      </section>
      {data.approval ? (
        <section className="space-y-3 rounded-lg border bg-card p-6">
          <h2 className="text-xl font-semibold">Approval snapshot</h2>
          <p className="text-sm text-muted-foreground">
            Fixed when approved
            {data.decidedAt ? ` ${time(data.decidedAt)}` : ""}. Recoverable GST
            is never job cost.
          </p>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-muted-foreground">Job cost</dt>
              <dd className="money font-semibold">
                {aud(data.approval.jobCostCents)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Claimable GST</dt>
              <dd className="money">{aud(data.approval.creditableGstCents)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                Non-claimable GST (in cost)
              </dt>
              <dd className="money">
                {aud(data.approval.nonCreditableGstCents)}
              </dd>
            </div>
          </dl>
          <p className="text-sm">
            {data.approval.companyGstRegistered
              ? "Company registered for GST on the purchase date."
              : "Company not registered for GST on the purchase date, so no GST is claimable."}{" "}
            {data.approval.evidenceVerified
              ? data.approval.hasEvidence
                ? "Receipt verified as qualifying evidence."
                : "Receipt verified, but a tax invoice is needed over $82.50."
              : "Receipt not verified."}
          </p>
        </section>
      ) : null}
      {canApprove && data.status === "submitted" ? (
        <Decision
          expense={data}
          onDone={(text) => {
            setMessage({ kind: "success", text });
            reload();
          }}
        />
      ) : null}
      {canApprove &&
      data.status === "approved" &&
      !data.reversesId &&
      !data.reversedById ? (
        <Reversal
          expense={data}
          onDone={() => {
            setMessage({
              kind: "success",
              text: "Expense reversed. The reversal is approved and audited.",
            });
            reload();
          }}
        />
      ) : null}
      {data.reversedById ? (
        <p className="rounded-lg bg-muted p-4">
          This expense was reversed.{" "}
          <Link className="underline" href={`/expenses/${data.reversedById}`}>
            Open the reversal
          </Link>
        </p>
      ) : null}
    </>
  );
}
function Decision({
  expense,
  onDone,
}: {
  expense: OfficeExpense;
  onDone: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<Message>(null);
  useUnsavedChanges(dirty);
  return (
    <form
      className="space-y-4 rounded-lg border bg-card p-6"
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = new FormData(e.currentTarget),
          decision = String(form.get("decision"));
        if (
          !window.confirm(
            decision === "approve"
              ? "Approve this expense? Its cost and GST are fixed and it can only be corrected by a reversal."
              : "Reject this expense? The submitter will see your note.",
          )
        )
          return;
        setBusy(true);
        const result = await sendJson(
          `/api/expenses/${expense.id}/decision`,
          "POST",
          {
            decision,
            note: String(form.get("note") ?? "").trim() || null,
            evidenceVerified: form.get("evidenceVerified") === "on",
          },
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        onDone(
          decision === "approve" ? "Expense approved." : "Expense rejected.",
        );
      }}
    >
      <h2 className="text-xl font-semibold">Decide</h2>
      <fieldset className="space-y-4" disabled={busy}>
        <legend className="sr-only">Approve or reject</legend>
        <Field id="decision" label="Decision">
          {(control) => (
            <select {...control} name="decision" defaultValue="approve">
              <option value="approve">Approve</option>
              <option value="reject">Reject</option>
            </select>
          )}
        </Field>
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            name="evidenceVerified"
            disabled={!expense.receiptDocumentId}
          />
          I checked the attached receipt or tax invoice
        </label>
        {errors.evidenceVerified ? (
          <p className="text-sm text-danger-foreground">
            {errors.evidenceVerified}
          </p>
        ) : null}
        <Field id="decision-note" label="Note" error={errors.note}>
          {(control) => (
            <textarea
              {...control}
              className={`${control.className} min-h-24 py-3`}
              name="note"
              maxLength={500}
            />
          )}
        </Field>
      </fieldset>
      <FormMessage message={message} />
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Record decision"}
      </Button>
    </form>
  );
}
function Reversal({
  expense,
  onDone,
}: {
  expense: OfficeExpense;
  onDone: () => void;
}) {
  const paid = expense.settlement === "paid_at_purchase";
  const [effect, setEffect] = useState("none");
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<Message>(null);
  useUnsavedChanges(dirty);
  return (
    <form
      className="space-y-4 rounded-lg border bg-card p-6"
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = new FormData(e.currentTarget);
        if (
          !window.confirm(
            "Reverse this approved expense? A reversal with the exact negated amounts is recorded; the original is kept.",
          )
        )
          return;
        setBusy(true);
        const result = await sendJson(
          `/api/expenses/${expense.id}/reversal`,
          "POST",
          {
            note: String(form.get("note") ?? ""),
            settlement: effect,
            ...(effect === "refund"
              ? {
                  refundedOn: String(form.get("refundedOn") ?? ""),
                  paymentMethod: String(form.get("refundMethod") ?? "card"),
                }
              : {}),
          },
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({ kind: "error", text: result.message });
          return;
        }
        setDirty(false);
        onDone();
      }}
    >
      <h2 className="text-xl font-semibold">Reverse</h2>
      <p className="text-sm text-muted-foreground">
        Approved expenses are never edited or deleted. A reversal corrects cost
        and GST; cash moves only if a refund or supplier credit is recorded.
      </p>
      <fieldset className="space-y-4" disabled={busy}>
        <legend className="sr-only">Reversal details</legend>
        <Field id="reversal-note" label="Reason *" error={errors.note}>
          {(control) => (
            <textarea
              {...control}
              className={`${control.className} min-h-24 py-3`}
              name="note"
              maxLength={500}
            />
          )}
        </Field>
        <Field
          id="reversal-effect"
          label="Money back"
          error={errors.settlement}
        >
          {(control) => (
            <select
              {...control}
              value={effect}
              onChange={(e) => setEffect(e.target.value)}
            >
              <option value="none">None (cost correction only)</option>
              {paid ? (
                <option value="refund">Refund received</option>
              ) : (
                <option value="supplier_credit">Supplier credit</option>
              )}
            </select>
          )}
        </Field>
        {effect === "refund" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              id="refunded-on"
              label="Refunded on *"
              error={errors.refundedOn}
            >
              {(control) => (
                <input {...control} type="date" name="refundedOn" />
              )}
            </Field>
            <Field
              id="refund-method"
              label="Refund method"
              error={errors.paymentMethod}
            >
              {(control) => (
                <select {...control} name="refundMethod" defaultValue="card">
                  {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        ) : null}
      </fieldset>
      <FormMessage message={message} />
      <Button type="submit" variant="destructive" disabled={busy}>
        {busy ? "Saving…" : "Reverse expense"}
      </Button>
    </form>
  );
}
