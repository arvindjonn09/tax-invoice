"use client";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { MoneyDisplay } from "@/components/money-display";
import { Button } from "@/components/ui/button";
import { day, time } from "@/features/jobs/types";
import { parseAudInput } from "@/lib/aud-input";

/** A subcontractor's own submitted invoice (#139): no company figures. */
export type OwnBillSubmission = {
  id: string;
  offerId: string;
  supplierReference: string;
  issuedOn: string;
  dueOn: string | null;
  totalCents: string;
  status: "submitted" | "approved" | "rejected";
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
};

const STATUS: Record<OwnBillSubmission["status"], string> = {
  submitted: "Waiting for the office",
  approved: "Approved",
  rejected: "Needs changes",
};

/**
 * Submit your own tax invoice for an accepted offer, and see what the
 * office decided. The office verifies the invoice before it is recorded.
 */
export function BillSubmissionPanel({ offerId }: { offerId: string }) {
  const { data, error, reload } = useRemote<{
    gstRegistered: boolean;
    submissions: OwnBillSubmission[];
  }>(`/api/my/bills?offerId=${offerId}&pageSize=100`);
  // Their current registration (it can change after the offer was made).
  const gstRegistered = data?.gstRegistered ?? false;
  const [taxCode, setTaxCode] = useState("TAXABLE_10");
  const charges = gstRegistered && taxCode === "TAXABLE_10";
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  useUnsavedChanges(dirty);
  const mine = data?.submissions ?? [];
  return (
    <section
      aria-labelledby="bill-heading"
      className="min-w-0 space-y-4 rounded-lg border bg-card p-6 [overflow-wrap:anywhere]"
    >
      <h2 id="bill-heading" className="text-xl font-semibold">
        Your invoices
      </h2>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <p role="status">Loading your invoices…</p>
      ) : mine.length === 0 ? (
        <p>You haven&apos;t submitted an invoice for this work yet.</p>
      ) : (
        <ul className="space-y-3">
          {mine.map((s) => (
            <li key={s.id} className="rounded-lg bg-muted p-4">
              <p className="font-semibold">
                Invoice {s.supplierReference} · {day(s.issuedOn)} ·{" "}
                <MoneyDisplay cents={BigInt(s.totalCents)} basis="incl GST" />
              </p>
              <p>
                {STATUS[s.status]}
                {s.decidedAt ? ` · ${time(s.decidedAt)}` : ""}
              </p>
              {s.decisionNote ? (
                <p className="whitespace-pre-wrap">
                  Office note: {s.decisionNote}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-4 border-t pt-4"
        onChange={() => setDirty(true)}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const element = e.currentTarget,
            form = new FormData(element);
          setMessage(null);
          let exclusive: string | null, gst: string | null;
          try {
            exclusive = parseAudInput(String(form.get("exclusive") ?? ""));
            gst = charges ? parseAudInput(String(form.get("gst") ?? "")) : "0";
          } catch (problem) {
            setMessage({
              kind: "error",
              text: (problem as Error).message,
            });
            return;
          }
          if (!exclusive) {
            setMessage({ kind: "error", text: "Enter the amount ex GST." });
            return;
          }
          const file = form.get("file");
          if (!(file instanceof File) || !file.size) {
            setMessage({ kind: "error", text: "Attach your tax invoice." });
            return;
          }
          if (file.size > 10 * 1024 * 1024) {
            setMessage({
              kind: "error",
              text: "Files can be at most 10 MB.",
            });
            return;
          }
          setBusy(true);
          const upload = new FormData();
          upload.set("file", file);
          upload.set("kind", "tax_invoice");
          const response = await fetch("/api/documents", {
            method: "POST",
            body: upload,
          }).catch(() => null);
          const uploaded = (await response?.json().catch(() => null)) as {
            id?: string;
            error?: string;
          } | null;
          if (!response?.ok || !uploaded?.id) {
            setBusy(false);
            setMessage({
              kind: "error",
              text:
                uploaded?.error ?? "Couldn't upload the invoice. Try again.",
            });
            return;
          }
          const due = String(form.get("dueOn") ?? "");
          const result = await sendJson("/api/my/bills", "POST", {
            offerId,
            supplierReference: String(form.get("reference") ?? "").trim(),
            issuedOn: String(form.get("issuedOn") ?? ""),
            dueOn: due || null,
            lines: [
              {
                description:
                  String(form.get("description") ?? "").trim() ||
                  "Work as offered",
                taxCode: gstRegistered ? taxCode : "OUT_OF_SCOPE",
                exclusiveCents: exclusive,
                gstCents: gst ?? "0",
              },
            ],
            documentId: uploaded.id,
            note: String(form.get("note") ?? "").trim() || null,
          });
          setBusy(false);
          if (!result.ok) {
            setMessage({ kind: "error", text: result.message });
            return;
          }
          element.reset();
          setDirty(false);
          setMessage({
            kind: "success",
            text: "Invoice sent. The office will check it and let you know.",
          });
          reload();
        }}
      >
        <fieldset
          className="grid gap-4 sm:grid-cols-2"
          // Wait for their GST registration before offering GST fields.
          disabled={busy || !data}
        >
          <legend className="mb-3 font-semibold">Submit an invoice</legend>
          <Field id="bill-reference" label="Invoice number">
            {(control) => (
              <input {...control} name="reference" required maxLength={100} />
            )}
          </Field>
          <Field id="bill-issued" label="Invoice date">
            {(control) => (
              <input {...control} name="issuedOn" type="date" required />
            )}
          </Field>
          <Field id="bill-due" label="Due date (optional)">
            {(control) => <input {...control} name="dueOn" type="date" />}
          </Field>
          <Field id="bill-description" label="Description">
            {(control) => (
              <input
                {...control}
                name="description"
                maxLength={500}
                placeholder="Work as offered"
              />
            )}
          </Field>
          <Field id="bill-exclusive" label="Amount ex GST (AUD)">
            {(control) => (
              <input
                {...control}
                name="exclusive"
                inputMode="decimal"
                required
              />
            )}
          </Field>
          {gstRegistered ? (
            <Field id="bill-tax-code" label="GST treatment">
              {(control) => (
                <select
                  {...control}
                  name="taxCode"
                  value={taxCode}
                  onChange={(event) => setTaxCode(event.target.value)}
                >
                  <option value="TAXABLE_10">Taxable (GST 10%)</option>
                  <option value="GST_FREE">GST-free</option>
                </select>
              )}
            </Field>
          ) : (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              You&apos;re not registered for GST, so your invoice has no GST.
            </p>
          )}
          {charges ? (
            <Field
              id="bill-gst"
              label="GST (AUD)"
              hint="As shown on your tax invoice"
            >
              {(control) => (
                <input {...control} name="gst" inputMode="decimal" required />
              )}
            </Field>
          ) : null}
          <Field id="bill-file" label="Tax invoice (PDF or image, up to 10 MB)">
            {(control) => (
              <input
                {...control}
                name="file"
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                required
              />
            )}
          </Field>
          <Field id="bill-note" label="Note to the office (optional)">
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
        <Button type="submit" disabled={busy || !data}>
          {busy ? "Sending…" : "Send invoice"}
        </Button>
        <FormMessage message={message} />
      </form>
    </section>
  );
}
