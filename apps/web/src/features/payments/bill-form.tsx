"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import {
  Field,
  FormMessage,
  TextField,
  sendJson,
} from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import { formatAudCents } from "@/components/money-display";
import { parseAudInput } from "@/lib/aud-input";
import { JobPicker } from "@/features/jobs/job-picker";
import { TAX_CODES } from "./types";

const MAX_BYTES = 10 * 1024 * 1024;

type DraftLine = {
  key: string;
  description: string;
  taxCode: string;
  exclusive: string;
  gst: string;
};

const blank = (key: string): DraftLine => ({
  key,
  description: "",
  taxCode: "TAXABLE_10",
  exclusive: "",
  gst: "",
});

function centsOf(text: string): bigint | null | "invalid" {
  try {
    const value = parseAudInput(text);
    return value === null ? null : BigInt(value);
  } catch {
    return "invalid";
  }
}

/** GST at 10% rounded half up, for a taxable line left blank. */
const tenPercent = (exclusive: bigint) => (exclusive + 5n) / 10n;

/**
 * Record a supplier or contractor bill. Amounts are copied from the
 * supplier's document; the server fixes job cost and creditable GST.
 */
export function BillForm({ today }: { today: string }) {
  const router = useRouter();
  const [source, setSource] = useState<"contractor" | "supplier">("supplier");
  const [contractorId, setContractorId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierAbn, setSupplierAbn] = useState("");
  const [registered, setRegistered] = useState<"" | "yes" | "no">("");
  const [reference, setReference] = useState("");
  const [jobId, setJobId] = useState("");
  const [issuedOn, setIssuedOn] = useState(today);
  const [dueOn, setDueOn] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blank("line-0")]);
  const keys = useRef(1);
  const [share, setShare] = useState("100");
  const [reason, setReason] = useState("");
  const [verified, setVerified] = useState(false);
  const [documentKind, setDocumentKind] = useState<"tax_invoice" | "receipt">(
    "tax_invoice",
  );
  const [note, setNote] = useState("");
  const [uploaded, setUploaded] = useState<{
    id: string;
    fileName: string;
  } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  useUnsavedChanges(dirty);

  const contractors = useRemote<{
    contractors: { id: string; name: string; gstRegistered?: boolean }[];
  }>(source === "contractor" ? "/api/contractors?pageSize=100" : null);

  const touch = () => {
    setDirty(true);
    setMessage(null);
  };
  const update = (key: string, patch: Partial<DraftLine>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
    touch();
  };

  /** Each line's cents as entered (blank taxable GST → 10%), for the preview. */
  const amounts = lines.map((line) => {
    const exclusive = centsOf(line.exclusive);
    const entered = centsOf(line.gst);
    const gst =
      entered === null && typeof exclusive === "bigint"
        ? line.taxCode === "TAXABLE_10"
          ? tenPercent(exclusive)
          : 0n
        : entered;
    return { exclusive, gst };
  });
  const valid = amounts.flatMap((amount) =>
    typeof amount.exclusive === "bigint" && typeof amount.gst === "bigint"
      ? [{ exclusive: amount.exclusive, gst: amount.gst }]
      : [],
  );
  const total =
    valid.length === amounts.length
      ? valid.reduce(
          (sum, amount) => ({
            exclusive: sum.exclusive + amount.exclusive,
            gst: sum.gst + amount.gst,
          }),
          { exclusive: 0n, gst: 0n },
        )
      : null;

  const fail = (fields: Record<string, string>, text: string) => {
    setErrors(fields);
    setMessage({ kind: "error", text });
    requestAnimationFrame(() => summary.current?.focus());
  };

  async function save() {
    const local: Record<string, string> = {};
    amounts.forEach((amount, index) => {
      if (typeof amount.exclusive !== "bigint")
        local[`lines.${index}.exclusiveCents`] =
          `Enter the ex-GST amount of line ${index + 1} (AUD, up to two decimal places).`;
      if (amount.gst === "invalid")
        local[`lines.${index}.gstCents`] =
          `Enter the GST of line ${index + 1} (AUD, up to two decimal places).`;
    });
    const percent = /^\d{1,3}$/.test(share.trim()) ? Number(share.trim()) : NaN;
    if (!(percent >= 0 && percent <= 100))
      local.creditableBasisPoints =
        "Enter a business-use share from 0 to 100%.";
    if (source === "contractor" && !contractorId)
      local.contractorId = "Choose a contractor.";
    if (source === "supplier" && !supplierName.trim())
      local.supplierName = "Enter the supplier's name.";
    if (source === "supplier" && !registered)
      local.supplierGstRegistered =
        "Say whether the supplier is registered for GST.";
    if (Object.keys(local).length)
      return fail(local, "Fix the highlighted fields.");

    setBusy(true);
    let evidence = uploaded;
    const chosen = file.current?.files?.[0];
    if (!evidence && chosen) {
      if (chosen.size > MAX_BYTES) {
        setBusy(false);
        return fail(
          { documentId: "Files can be at most 10 MB." },
          "Fix the highlighted fields.",
        );
      }
      const body = new FormData();
      body.set("file", chosen);
      body.set("kind", documentKind);
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
        return fail(
          {
            documentId:
              json?.error ?? "Couldn't upload the document. Try again.",
          },
          "The document wasn't uploaded.",
        );
      }
      evidence = { id: json.id, fileName: json.fileName ?? chosen.name };
      setUploaded(evidence);
    }
    const result = await sendJson("/api/bills", "POST", {
      ...(source === "contractor"
        ? { contractorId }
        : {
            supplierName: supplierName.trim(),
            ...(supplierAbn.trim() ? { supplierAbn: supplierAbn.trim() } : {}),
            supplierGstRegistered: registered === "yes",
          }),
      jobId: jobId || null,
      supplierReference: reference.trim() || null,
      issuedOn,
      dueOn: dueOn || null,
      lines: lines.map((line, index) => ({
        description: line.description,
        taxCode: line.taxCode,
        exclusiveCents: (amounts[index]!.exclusive as bigint).toString(),
        gstCents: (amounts[index]!.gst as bigint).toString(),
      })),
      documentId: evidence?.id ?? null,
      evidenceVerified: verified,
      creditableBasisPoints: percent * 100,
      creditableReason: reason.trim() || null,
      note: note.trim() || null,
    });
    setBusy(false);
    if (!result.ok) return fail(result.fields, result.message);
    setDirty(false);
    router.push(
      `/payments/bills/${(result.body as { id: string }).id}?recorded=1`,
    );
  }

  const errorList = Object.entries(errors);
  const lineError = (index: number, field: string) =>
    errors[`lines.${index}.${field}`];
  return (
    <>
      <PageHeader
        title="Record bill"
        description="Copy the amounts from the supplier's bill. Once recorded, a bill can only be voided."
        breadcrumbs={[
          { label: "Payments", href: "/payments?view=bills" },
          { label: "Record bill" },
        ]}
      />
      <div aria-live="polite">
        <section
          className={
            errorList.length
              ? "rounded-lg border border-danger-foreground p-4"
              : "sr-only"
          }
        >
          <h2 ref={summary} tabIndex={-1} className="font-semibold">
            {errorList.length
              ? `Fix ${errorList.length} ${errorList.length === 1 ? "problem" : "problems"}`
              : "No problems"}
          </h2>
          {errorList.length ? (
            <ul className="list-disc pl-6">
              {errorList.map(([field, text]) => (
                <li key={field}>{text}</li>
              ))}
            </ul>
          ) : null}
        </section>
        <FormMessage message={message} />
      </div>
      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void save();
        }}
      >
        <fieldset
          disabled={busy}
          className="space-y-4 rounded-lg border bg-card p-6"
        >
          <legend className="text-xl font-semibold">Supplier</legend>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-2 font-medium">Who sent the bill?</legend>
            {(
              [
                ["supplier", "A supplier"],
                ["contractor", "One of our contractors"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name="bill-source"
                  checked={source === value}
                  onChange={() => {
                    setSource(value);
                    touch();
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {source === "contractor" ? (
            <Field
              id="bill-contractor"
              label="Contractor (required)"
              hint="The bill takes the contractor's name, ABN and GST registration."
              error={errors.contractorId}
            >
              {(control) => (
                <select
                  {...control}
                  value={contractorId}
                  onChange={(event) => {
                    setContractorId(event.target.value);
                    touch();
                  }}
                >
                  <option value="">Choose a contractor</option>
                  {contractors.data?.contractors.map((contractor) => (
                    <option key={contractor.id} value={contractor.id}>
                      {contractor.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                id="bill-supplier"
                label="Supplier name (required)"
                maxLength={200}
                value={supplierName}
                error={errors.supplierName}
                onChange={(event) => {
                  setSupplierName(event.target.value);
                  touch();
                }}
              />
              <TextField
                id="bill-abn"
                label="Supplier ABN"
                hint="Required when the supplier is registered for GST."
                inputMode="numeric"
                maxLength={14}
                value={supplierAbn}
                error={errors.supplierAbn}
                onChange={(event) => {
                  setSupplierAbn(event.target.value);
                  touch();
                }}
              />
              <Field
                id="bill-registered"
                label="Supplier registered for GST? (required)"
                error={errors.supplierGstRegistered}
              >
                {(control) => (
                  <select
                    {...control}
                    value={registered}
                    onChange={(event) => {
                      setRegistered(event.target.value as "" | "yes" | "no");
                      touch();
                    }}
                  >
                    <option value="">Choose</option>
                    <option value="yes">Yes — the bill shows GST</option>
                    <option value="no">No — no GST can be charged</option>
                  </select>
                )}
              </Field>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              id="bill-reference"
              label="Supplier's bill number"
              maxLength={100}
              value={reference}
              error={errors.supplierReference}
              onChange={(event) => {
                setReference(event.target.value);
                touch();
              }}
            />
            <div className="md:col-span-2">
              <JobPicker
                id="bill-job"
                label="Job (optional)"
                hint="Its cost counts towards the job's profit."
                value={jobId}
                emptyLabel="Overhead — no job"
                error={errors.jobId}
                onChange={(id) => {
                  setJobId(id);
                  touch();
                }}
              />
            </div>
            <TextField
              id="bill-issued"
              label="Bill date (required)"
              type="date"
              max={today}
              value={issuedOn}
              error={errors.issuedOn}
              onChange={(event) => {
                setIssuedOn(event.target.value);
                touch();
              }}
            />
            <TextField
              id="bill-due"
              label="Due date"
              type="date"
              min={issuedOn}
              value={dueOn}
              error={errors.dueOn}
              onChange={(event) => {
                setDueOn(event.target.value);
                touch();
              }}
            />
          </div>
        </fieldset>

        <fieldset
          disabled={busy}
          className="space-y-4 rounded-lg border bg-card p-6"
        >
          <legend className="text-xl font-semibold">Lines</legend>
          <p className="text-sm text-muted-foreground">
            Enter each line as the supplier shows it. Leave GST blank on a
            taxable line to use 10% of the ex-GST amount.
          </p>
          <ol className="space-y-4">
            {lines.map((line, index) => {
              const amount = amounts[index]!;
              return (
                <li key={line.key} className="rounded-lg border p-4">
                  <fieldset className="space-y-3">
                    <legend className="font-semibold">Line {index + 1}</legend>
                    <TextField
                      id={`${line.key}-description`}
                      label="Description (required)"
                      maxLength={500}
                      value={line.description}
                      error={lineError(index, "description")}
                      onChange={(event) =>
                        update(line.key, { description: event.target.value })
                      }
                    />
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field
                        id={`${line.key}-tax`}
                        label="GST treatment (required)"
                        error={lineError(index, "taxCode")}
                      >
                        {(control) => (
                          <select
                            {...control}
                            value={line.taxCode}
                            onChange={(event) =>
                              update(line.key, { taxCode: event.target.value })
                            }
                          >
                            {TAX_CODES.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                      <TextField
                        id={`${line.key}-exclusive`}
                        label="Amount ex GST (required)"
                        inputMode="decimal"
                        value={line.exclusive}
                        error={lineError(index, "exclusiveCents")}
                        onChange={(event) =>
                          update(line.key, { exclusive: event.target.value })
                        }
                      />
                      <TextField
                        id={`${line.key}-gst`}
                        label="GST"
                        inputMode="decimal"
                        value={line.gst}
                        error={lineError(index, "gstCents")}
                        onChange={(event) =>
                          update(line.key, { gst: event.target.value })
                        }
                      />
                    </div>
                    <p className="text-sm tabular-nums">
                      {typeof amount.exclusive === "bigint" &&
                      typeof amount.gst === "bigint"
                        ? `${formatAudCents(amount.exclusive)} ex GST · ${formatAudCents(amount.gst)} GST · ${formatAudCents(amount.exclusive + amount.gst)} incl GST`
                        : "Enter the amounts to see this line's total."}
                    </p>
                    {lines.length > 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setLines((current) =>
                            current.filter((item) => item.key !== line.key),
                          );
                          touch();
                        }}
                      >
                        Remove line {index + 1}
                      </Button>
                    ) : null}
                  </fieldset>
                </li>
              );
            })}
          </ol>
          <Button
            type="button"
            variant="outline"
            disabled={lines.length >= 100}
            onClick={() => {
              const line = blank(`line-${keys.current++}`);
              setLines((current) => [...current, line]);
              touch();
              requestAnimationFrame(() =>
                document.getElementById(`${line.key}-description`)?.focus(),
              );
            }}
          >
            Add line
          </Button>
          <section
            aria-label="Bill total"
            className="rounded-lg border bg-muted p-4"
          >
            <dl className="grid gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-sm">Ex GST</dt>
                <dd className="font-semibold tabular-nums">
                  {total ? `${formatAudCents(total.exclusive)} AUD` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-sm">GST</dt>
                <dd className="font-semibold tabular-nums">
                  {total ? `${formatAudCents(total.gst)} AUD` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-sm">Incl GST</dt>
                <dd className="font-semibold tabular-nums">
                  {total
                    ? `${formatAudCents(total.exclusive + total.gst)} AUD`
                    : "—"}
                </dd>
              </div>
            </dl>
          </section>
        </fieldset>

        <fieldset
          disabled={busy}
          className="space-y-4 rounded-lg border bg-card p-6"
        >
          <legend className="text-xl font-semibold">GST claim</legend>
          <Field
            id="bill-document-kind"
            label="Evidence type"
            hint="GST on a bill over $82.50 incl GST is claimable only with a tax invoice; up to $82.50 a receipt is enough."
          >
            {(control) => (
              <select
                {...control}
                value={documentKind}
                onChange={(event) => {
                  setDocumentKind(
                    event.target.value as "tax_invoice" | "receipt",
                  );
                  setUploaded(null);
                  touch();
                }}
              >
                <option value="tax_invoice">Tax invoice</option>
                <option value="receipt">Receipt ($82.50 or less)</option>
              </select>
            )}
          </Field>
          <Field
            id="bill-document"
            label="Supplier's document (photo or PDF)"
            hint="JPEG, PNG, WebP, HEIC or PDF, at most 10 MB."
            error={errors.documentId}
          >
            {(control) => (
              <input
                {...control}
                ref={file}
                className={`${control.className} py-3`}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,.heic,application/pdf"
                onChange={() => {
                  setUploaded(null);
                  touch();
                }}
              />
            )}
          </Field>
          {uploaded ? (
            <p role="status">Private upload ready: {uploaded.fileName}.</p>
          ) : null}
          <label className="flex min-h-11 items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 size-5"
              checked={verified}
              onChange={(event) => {
                setVerified(event.target.checked);
                touch();
              }}
            />
            <span>
              I checked the attached document: it is from this supplier, is
              dated, and shows the GST charged (a tax invoice also shows the
              supplier’s ABN).
            </span>
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              id="bill-share"
              label="Business-use share (%)"
              hint="100% unless part of the purchase is private."
              inputMode="numeric"
              maxLength={3}
              value={share}
              error={errors.creditableBasisPoints}
              onChange={(event) => {
                setShare(event.target.value);
                touch();
              }}
            />
            <TextField
              id="bill-share-reason"
              label="Why only part is claimable"
              hint="Required below 100%."
              maxLength={500}
              value={reason}
              error={errors.creditableReason}
              onChange={(event) => {
                setReason(event.target.value);
                touch();
              }}
            />
          </div>
          <Field id="bill-note" label="Internal note" error={errors.note}>
            {(control) => (
              <textarea
                {...control}
                className={`${control.className} min-h-20 py-3`}
                maxLength={500}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  touch();
                }}
              />
            )}
          </Field>
        </fieldset>
        <Button type="submit" disabled={busy}>
          {busy ? "Recording…" : "Record bill"}
        </Button>
      </form>
    </>
  );
}
