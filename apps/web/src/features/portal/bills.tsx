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

type DraftLine = {
  key: number;
  description: string;
  taxCode: string;
  exclusive: string;
  gst: string;
};
let nextKey = 0;
const newLine = (): DraftLine => ({
  key: (nextKey += 1),
  description: "",
  taxCode: "TAXABLE_10",
  exclusive: "",
  gst: "",
});

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
  // One row per line of their tax invoice (taxable and GST-free can mix).
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const update = (key: number, change: Partial<DraftLine>) =>
    setLines((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
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
          const payload: {
            description: string;
            taxCode: string;
            exclusiveCents: string;
            gstCents: string;
          }[] = [];
          for (const [index, line] of lines.entries()) {
            const taxCode = gstRegistered ? line.taxCode : "OUT_OF_SCOPE";
            let exclusive: string | null, gst: string | null;
            try {
              exclusive = parseAudInput(line.exclusive);
              gst = taxCode === "TAXABLE_10" ? parseAudInput(line.gst) : "0";
            } catch (problem) {
              setMessage({
                kind: "error",
                text: `Line ${index + 1}: ${(problem as Error).message}`,
              });
              return;
            }
            if (!exclusive) {
              setMessage({
                kind: "error",
                text: `Line ${index + 1}: enter the amount ex GST.`,
              });
              return;
            }
            payload.push({
              description: line.description.trim() || "Work as offered",
              taxCode,
              exclusiveCents: exclusive,
              gstCents: gst ?? "0",
            });
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
            lines: payload,
            documentId: uploaded.id,
            note: String(form.get("note") ?? "").trim() || null,
          });
          setBusy(false);
          if (!result.ok) {
            setMessage({ kind: "error", text: result.message });
            return;
          }
          element.reset();
          setLines([newLine()]);
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
          {!gstRegistered ? (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              You&apos;re not registered for GST, so your invoice has no GST.
            </p>
          ) : null}
          {lines.map((line, index) => {
            const n = index + 1;
            const charges = gstRegistered && line.taxCode === "TAXABLE_10";
            return (
              <fieldset
                key={line.key}
                className="grid gap-4 rounded-lg border p-4 sm:col-span-2 sm:grid-cols-2"
              >
                <legend className="px-1 font-semibold">Line {n}</legend>
                <Field
                  id={`bill-description-${line.key}`}
                  label={`Line ${n} description`}
                >
                  {(control) => (
                    <input
                      {...control}
                      maxLength={500}
                      placeholder="Work as offered"
                      value={line.description}
                      onChange={(event) =>
                        update(line.key, { description: event.target.value })
                      }
                    />
                  )}
                </Field>
                {gstRegistered ? (
                  <Field
                    id={`bill-tax-${line.key}`}
                    label={`Line ${n} GST treatment`}
                  >
                    {(control) => (
                      <select
                        {...control}
                        value={line.taxCode}
                        onChange={(event) =>
                          update(line.key, { taxCode: event.target.value })
                        }
                      >
                        <option value="TAXABLE_10">Taxable (GST 10%)</option>
                        <option value="GST_FREE">GST-free</option>
                      </select>
                    )}
                  </Field>
                ) : null}
                <Field
                  id={`bill-exclusive-${line.key}`}
                  label={`Line ${n} amount ex GST (AUD)`}
                >
                  {(control) => (
                    <input
                      {...control}
                      inputMode="decimal"
                      required
                      value={line.exclusive}
                      onChange={(event) =>
                        update(line.key, { exclusive: event.target.value })
                      }
                    />
                  )}
                </Field>
                {charges ? (
                  <Field
                    id={`bill-gst-${line.key}`}
                    label={`Line ${n} GST (AUD)`}
                    hint="As shown on your tax invoice"
                  >
                    {(control) => (
                      <input
                        {...control}
                        inputMode="decimal"
                        required
                        value={line.gst}
                        onChange={(event) =>
                          update(line.key, { gst: event.target.value })
                        }
                      />
                    )}
                  </Field>
                ) : null}
                {lines.length > 1 ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setLines((rows) =>
                        rows.filter((row) => row.key !== line.key),
                      )
                    }
                  >
                    Remove line {n}
                  </Button>
                ) : null}
              </fieldset>
            );
          })}
          <div className="sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              disabled={lines.length >= 100}
              onClick={() => setLines((rows) => [...rows, newLine()])}
            >
              Add a line
            </Button>
          </div>
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
