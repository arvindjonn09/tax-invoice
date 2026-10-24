"use client";
import { useState } from "react";
import { EXPENSE_CATEGORIES, TAX_CODES, type TaxCode } from "@jobflow/domain";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { Field, FormMessage, sendJson } from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { audInput, parseAudInput } from "@/lib/aud-input";
import { GstBreakdown, previewAmounts } from "./breakdown";
import {
  CATEGORY_LABELS,
  PAYMENT_LABELS,
  TAX_CODE_LABELS,
  type JobOption,
  type OwnExpense,
  type PaymentMethod,
} from "./types";
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
/** Today in Sydney as YYYY-MM-DD, the server's "not in the future" bound. */
function sydneyToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
  }).format(new Date());
}
function amountOrNull(text: string): string | null {
  try {
    return parseAudInput(text);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
/**
 * Create or edit an expense. Office staff may file a general (no-job)
 * expense and set the business-use share; employees pick an assigned job.
 */
export function ExpenseForm({
  jobs,
  office,
  initial,
  onSaved,
  onCancel,
}: {
  jobs: JobOption[];
  office: boolean;
  initial?: OwnExpense;
  onSaved: (expense: OwnExpense) => void;
  onCancel: () => void;
}) {
  const today = sydneyToday();
  const [amount, setAmount] = useState(audInput(initial?.amountCents));
  const [priceEntry, setPriceEntry] = useState<"exclusive" | "inclusive">(
    initial?.priceEntry ?? "inclusive",
  );
  const [taxCode, setTaxCode] = useState<TaxCode>(
    initial?.taxCode ?? "TAXABLE_10",
  );
  const [settlement, setSettlement] = useState(
    initial?.settlement ?? "paid_at_purchase",
  );
  const [uploaded, setUploaded] = useState<{
    id: string;
    fileName: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  useUnsavedChanges(dirty);
  const cents = amountOrNull(amount);
  const preview = previewAmounts(cents, priceEntry, taxCode);
  const id = (name: string) => `expense-${initial?.id ?? "new"}-${name}`;
  return (
    <form
      className="space-y-4"
      noValidate
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = new FormData(e.currentTarget);
        setMessage(null);
        if (cents === null) {
          setErrors({
            amountCents:
              "Enter a non-negative AUD amount with at most two decimal places.",
          });
          return;
        }
        setErrors({});
        setBusy(true);
        let receipt = uploaded;
        const file = form.get("receipt");
        if (!receipt && file instanceof File && file.size) {
          if (file.size > MAX_RECEIPT_BYTES) {
            setBusy(false);
            setErrors({ receiptDocumentId: "Receipts can be at most 10 MB." });
            return;
          }
          const body = new FormData();
          body.set("file", file);
          body.set("kind", String(form.get("receiptKind") ?? "receipt"));
          const response = await fetch("/api/documents", {
            method: "POST",
            body,
          }).catch(() => null);
          const json = (await response?.json().catch(() => null)) as {
            id?: string;
            fileName?: string;
            error?: string;
          } | null;
          if (!response?.ok || !json?.id) {
            setBusy(false);
            setErrors({
              receiptDocumentId:
                json?.error ?? "Couldn't upload the receipt. Try again.",
            });
            return;
          }
          receipt = { id: json.id, fileName: json.fileName ?? file.name };
          setUploaded(receipt);
        }
        const paid = settlement === "paid_at_purchase";
        const text = (name: string) =>
          String(form.get(name) ?? "").trim() || null;
        const payload = {
          jobId: text("jobId"),
          category: form.get("category"),
          description: String(form.get("description") ?? ""),
          supplierName: text("supplierName"),
          purchasedOn: form.get("purchasedOn"),
          priceEntry,
          amountCents: cents,
          taxCode,
          ...(office
            ? { creditablePercent: String(form.get("creditablePercent")) }
            : {}),
          ...(receipt
            ? { receiptDocumentId: receipt.id }
            : initial
              ? {}
              : { receiptDocumentId: null }),
          settlement,
          paidOn: paid ? text("paidOn") : null,
          paymentMethod: paid
            ? ((text("paymentMethod") as PaymentMethod | null) ?? null)
            : null,
        };
        const result = await sendJson(
          initial ? `/api/expenses/${initial.id}` : "/api/expenses",
          initial ? "PATCH" : "POST",
          payload,
        );
        setBusy(false);
        if (!result.ok) {
          setErrors(result.fields);
          setMessage({
            kind: "error",
            text: receipt
              ? `${result.message} Your receipt is stored privately and will be attached when you save again.`
              : result.message,
          });
          return;
        }
        setDirty(false);
        setUploaded(null);
        onSaved(result.body as OwnExpense);
      }}
    >
      <fieldset className="space-y-4" disabled={busy}>
        <legend className="sr-only">
          {initial ? "Edit expense" : "New expense"}
        </legend>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id={id("job")}
            label={office ? "Job" : "Job *"}
            error={errors.jobId}
            {...(jobs.length === 0 && !office
              ? { hint: "You need an assigned job before you can claim." }
              : {})}
          >
            {(control) => (
              <select
                {...control}
                name="jobId"
                defaultValue={initial?.jobId ?? (office ? "" : jobs[0]?.id)}
              >
                {office ? (
                  <option value="">No job (general expense)</option>
                ) : null}
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.reference} · {job.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id={id("category")} label="Category *" error={errors.category}>
            {(control) => (
              <select
                {...control}
                name="category"
                defaultValue={initial?.category ?? "materials"}
              >
                {EXPENSE_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field
          id={id("description")}
          label="What was bought *"
          error={errors.description}
        >
          {(control) => (
            <textarea
              {...control}
              className={`${control.className} min-h-24 py-3`}
              name="description"
              maxLength={500}
              defaultValue={initial?.description ?? ""}
            />
          )}
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id={id("supplier")}
            label="Supplier"
            error={errors.supplierName}
          >
            {(control) => (
              <input
                {...control}
                name="supplierName"
                maxLength={200}
                autoComplete="organization"
                defaultValue={initial?.supplierName ?? ""}
              />
            )}
          </Field>
          <Field
            id={id("purchased")}
            label="Purchase date *"
            error={errors.purchasedOn}
          >
            {(control) => (
              <input
                {...control}
                type="date"
                name="purchasedOn"
                max={today}
                defaultValue={initial?.purchasedOn ?? today}
              />
            )}
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="font-medium">The amount includes GST?</legend>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ["inclusive", "Incl GST (receipt total)"],
                ["exclusive", "Ex GST"],
              ] as const
            ).map(([value, label]) => (
              <label
                key={value}
                className="flex min-h-11 items-center gap-2 rounded-sm border bg-card px-4"
              >
                <input
                  type="radio"
                  name="priceEntry"
                  value={value}
                  checked={priceEntry === value}
                  onChange={() => setPriceEntry(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id={id("amount")}
            label={
              priceEntry === "inclusive"
                ? "Amount incl GST *"
                : "Amount ex GST *"
            }
            error={errors.amountCents}
            hint="AUD, for example 82.50"
          >
            {(control) => (
              <input
                {...control}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field
            id={id("tax")}
            label="GST treatment *"
            error={errors.taxCode}
            hint="Taxable if the receipt shows GST. GST-free and input-taxed purchases have none; out of scope is outside the GST system."
          >
            {(control) => (
              <select
                {...control}
                name="taxCode"
                value={taxCode}
                onChange={(e) => setTaxCode(e.target.value as TaxCode)}
              >
                {TAX_CODES.map((code) => (
                  <option key={code} value={code}>
                    {TAX_CODE_LABELS[code]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <GstBreakdown amounts={preview} />
        {office ? (
          <Field
            id={id("creditable")}
            label="Business use %"
            error={errors.creditablePercent}
            hint="The share of GST the company can claim. Use 100 unless part is private use."
          >
            {(control) => (
              <input
                {...control}
                name="creditablePercent"
                inputMode="decimal"
                defaultValue={initial?.creditablePercent ?? "100"}
              />
            )}
          </Field>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field id={id("receipt-kind")} label="Document type">
            {(control) => (
              <select {...control} name="receiptKind" defaultValue="receipt">
                <option value="receipt">Receipt</option>
                <option value="tax_invoice">Tax invoice</option>
              </select>
            )}
          </Field>
          <Field
            id={id("receipt")}
            label="Receipt photo or PDF"
            error={errors.receiptDocumentId}
            hint={
              initial?.receiptDocumentId && !uploaded
                ? "A receipt is attached. Choose a file only to replace it."
                : "JPEG, PNG, WebP, HEIC or PDF, at most 10 MB. Purchases over $82.50 need a tax invoice to claim GST."
            }
          >
            {(control) => (
              <input
                {...control}
                className={`${control.className} py-3`}
                type="file"
                name="receipt"
                accept="image/jpeg,image/png,image/webp,image/heic,.heic,application/pdf"
                capture="environment"
                onChange={() => setUploaded(null)}
              />
            )}
          </Field>
        </div>
        {uploaded ? (
          <p role="status">
            Private upload ready: {uploaded.fileName}. Save to attach it.
          </p>
        ) : null}
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            id={id("settlement")}
            label="How was it paid? *"
            error={errors.settlement}
          >
            {(control) => (
              <select
                {...control}
                name="settlement"
                value={settlement}
                onChange={(e) =>
                  setSettlement(e.target.value as OwnExpense["settlement"])
                }
              >
                <option value="paid_at_purchase">Paid at purchase</option>
                <option value="on_account">On account (pay later)</option>
              </select>
            )}
          </Field>
          {settlement === "paid_at_purchase" ? (
            <>
              <Field
                id={id("method")}
                label="Payment method *"
                error={errors.paymentMethod}
              >
                {(control) => (
                  <select
                    {...control}
                    name="paymentMethod"
                    defaultValue={initial?.paymentMethod ?? "card"}
                  >
                    {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field
                id={id("paid")}
                label="Paid on"
                error={errors.paidOn}
                hint="Leave blank if paid on the purchase date."
              >
                {(control) => (
                  <input
                    {...control}
                    type="date"
                    name="paidOn"
                    max={today}
                    defaultValue={initial?.paidOn ?? ""}
                  />
                )}
              </Field>
            </>
          ) : null}
        </div>
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save changes" : "Submit expense"}
        </Button>
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
      </div>
    </form>
  );
}
