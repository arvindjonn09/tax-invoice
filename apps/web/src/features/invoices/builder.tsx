"use client";
import Link from "next/link";
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
import { EntityPicker } from "@/features/jobs/picker";
import { audInput, parseAudInput } from "@/lib/aud-input";
import { Totals } from "./totals";
import {
  type Invoice,
  TAX_CODE_OPTIONS,
  type TaxCode,
  taxLabel,
} from "./types";

type DraftLine = {
  key: string;
  description: string;
  quantity: string;
  unit: string;
  price: string;
  taxCode: TaxCode;
};

const blankLine = (key: string, registered: boolean): DraftLine => ({
  key,
  description: "",
  quantity: "1",
  unit: "",
  price: "",
  taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
});

/**
 * Draft invoice or credit note. Totals come only from the server's last
 * save; editing marks them stale and blocks issue until saved again.
 */
export function InvoiceBuilder({
  initial,
  registeredToday,
  today,
  canIssue,
  creditsReference,
  onIssued,
}: {
  initial: Invoice | null;
  registeredToday: boolean;
  today: string;
  canIssue: boolean;
  creditsReference: string | null;
  /** Show the issued document (it comes back from the issue call). */
  onIssued?: (issued: Invoice) => void;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<Invoice | null>(initial);
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [jobId, setJobId] = useState(initial?.jobId ?? "");
  const [locationId, setLocationId] = useState(initial?.locationId ?? "");
  const [customerReference, setCustomerReference] = useState(
    initial?.customerReference ?? "",
  );
  const [dueOn, setDueOn] = useState(initial?.dueOn ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [priceEntry, setPriceEntry] = useState<"exclusive" | "inclusive">(
    initial?.priceEntry ?? "exclusive",
  );
  const [lines, setLines] = useState<DraftLine[]>(
    initial?.lines.length
      ? initial.lines.map((line, index) => ({
          key: `line-${index}`,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit ?? "",
          price: audInput(line.unitPriceCents),
          taxCode: line.taxCode,
        }))
      : [blankLine("line-0", registeredToday)],
  );
  // Keys must match between server render and hydration: start from the
  // initial lines and count up per component, never from a module global.
  const keyCounter = useRef(Math.max(1, initial?.lines.length ?? 0));
  const nextKey = () => `line-${keyCounter.current++}`;
  const [removed, setRemoved] = useState<{
    line: DraftLine;
    index: number;
  } | null>(null);
  const [dirty, setDirty] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [issueDate, setIssueDate] = useState(today);
  const [issueErrors, setIssueErrors] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  useUnsavedChanges(dirty);
  // Focus the error summary once the new errors have rendered.
  const focusSummary = () =>
    requestAnimationFrame(() => summary.current?.focus());
  const cancelIssue = useRef<HTMLButtonElement>(null);

  const isCredit = initial?.kind === "credit_note";
  const customer = useRemote<{
    name: string;
    locations: {
      id: string;
      label: string | null;
      addressLine1: string;
      suburb: string;
      archivedAt: string | null;
    }[];
  }>(customerId ? `/api/customers/${customerId}` : null);
  const jobs = useRemote<{
    jobs: { id: string; reference: string; title: string }[];
  }>(
    customerId && !isCredit
      ? `/api/jobs?${new URLSearchParams({ customerId, pageSize: "100" })}`
      : null,
  );
  const title = isCredit
    ? registeredToday
      ? "Adjustment Note"
      : "Credit Note"
    : registeredToday
      ? "Tax Invoice"
      : "Invoice";
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

  async function save(): Promise<Invoice | null> {
    const local: Record<string, string> = {};
    const body = lines.map((line, index) => {
      let cents: string | null = null;
      try {
        cents = parseAudInput(line.price);
      } catch {
        cents = null;
      }
      if (cents === null)
        local[`lines.${index}.unitPriceCents`] =
          `Enter a valid AUD amount with at most two decimal places for line ${index + 1}.`;
      return {
        description: line.description,
        quantity: line.quantity,
        unit: line.unit.trim() || null,
        unitPriceCents: cents ?? "0",
        taxCode: line.taxCode,
      };
    });
    if (!customerId) local.customerId = "Select a customer.";
    if (Object.keys(local).length) {
      setErrors(local);
      setMessage({ kind: "error", text: "Fix the highlighted fields." });
      focusSummary();
      return null;
    }
    setBusy(true);
    const result = await sendJson(
      saved ? `/api/invoices/${saved.id}` : "/api/invoices",
      saved ? "PATCH" : "POST",
      {
        ...(saved ? {} : { customerId }),
        ...(isCredit
          ? {}
          : { jobId: jobId || null, locationId: locationId || null }),
        priceEntry,
        customerReference: customerReference.trim() || null,
        notes: notes.trim() || null,
        dueOn: dueOn || null,
        lines: body,
      },
    );
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fields);
      setMessage({ kind: "error", text: result.message });
      focusSummary();
      return null;
    }
    const next = result.body as Invoice;
    setSaved(next);
    setErrors({});
    setDirty(false);
    setMessage({ kind: "success", text: "Draft saved." });
    // Give the new draft its own URL without remounting this form (a
    // navigation would swap the builder out from under the user).
    if (!saved) window.history.replaceState(null, "", `/invoices/${next.id}`);
    return next;
  }

  async function issue() {
    if (!saved || dirty) return;
    setBusy(true);
    setIssueErrors([]);
    const result = await sendJson(`/api/invoices/${saved.id}/issue`, "POST", {
      issueDate,
    });
    setBusy(false);
    if (!result.ok) {
      setIssueErrors([
        result.message,
        ...Object.values(result.fields).filter(
          (text) => text !== result.message,
        ),
      ]);
      return;
    }
    dialog.current?.close();
    setDirty(false);
    onIssued?.(result.body as Invoice);
    router.replace(`/invoices/${saved.id}?issued=1`);
  }

  const lineError = (index: number, field: string) =>
    errors[`lines.${index}.${field}`];
  const errorList = Object.entries(errors);
  const sites = customer.data?.locations.filter(
    (site) => !site.archivedAt || site.id === locationId,
  );

  return (
    <>
      <PageHeader
        title={title}
        description={
          isCredit
            ? `Draft credit note${creditsReference ? ` for ${creditsReference}` : ""} · Not issued`
            : "Draft · Not issued · Number assigned on issue"
        }
        breadcrumbs={[
          { label: "Invoices", href: "/invoices" },
          {
            label: saved
              ? `Draft ${isCredit ? "credit note" : "invoice"}`
              : "New invoice",
          },
        ]}
        actions={
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save draft"}
            </Button>
            {canIssue ? (
              <Button
                ref={reviewButton}
                disabled={busy || dirty || !saved || !saved.lines.length}
                onClick={() => {
                  setIssueErrors([]);
                  dialog.current?.showModal();
                  cancelIssue.current?.focus();
                }}
              >
                Review and issue
              </Button>
            ) : null}
          </div>
        }
      />
      {canIssue && (dirty || !saved) ? (
        <p className="text-sm text-muted-foreground">
          Save the draft before issuing: issue uses the totals the server
          confirms.
        </p>
      ) : null}
      {!canIssue ? (
        <p className="text-sm text-muted-foreground">
          You can prepare drafts; an owner or accountant issues them.
        </p>
      ) : null}
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
      <div className="grid gap-6 lg:grid-cols-3">
        <form
          className="space-y-6 lg:col-span-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset
            disabled={busy}
            className="space-y-4 rounded-lg border bg-card p-6"
          >
            <legend className="text-xl font-semibold">Customer and job</legend>
            {isCredit ? (
              <p>
                Customer: <strong>{customer.data?.name ?? "Loading…"}</strong>
              </p>
            ) : saved ? (
              <p>
                Customer: <strong>{customer.data?.name ?? "Loading…"}</strong>{" "}
                <span className="text-sm text-muted-foreground">
                  (start a new draft for another customer)
                </span>
              </p>
            ) : (
              <EntityPicker
                kind="customers"
                id="invoice-customer"
                label="Customer (required)"
                value={customerId}
                onChange={(id) => {
                  setCustomerId(id);
                  setJobId("");
                  setLocationId("");
                  touch();
                }}
                error={errors.customerId}
              />
            )}
            {!isCredit ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="invoice-job" label="Job" error={errors.jobId}>
                  {(control) => (
                    <select
                      {...control}
                      value={jobId}
                      disabled={!customerId}
                      onChange={(event) => {
                        setJobId(event.target.value);
                        touch();
                      }}
                    >
                      <option value="">No job</option>
                      {jobs.data?.jobs.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.reference} · {job.title}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field
                  id="invoice-site"
                  label="Service location (site address) (optional)"
                  error={errors.locationId}
                >
                  {(control) => (
                    <select
                      {...control}
                      value={locationId}
                      disabled={!customerId}
                      onChange={(event) => {
                        setLocationId(event.target.value);
                        touch();
                      }}
                    >
                      <option value="">No site</option>
                      {sites?.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.label ?? site.addressLine1} · {site.suburb}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="invoice-reference"
                label="Customer reference / PO number (optional)"
                maxLength={100}
                value={customerReference}
                error={errors.customerReference}
                onChange={(event) => {
                  setCustomerReference(event.target.value);
                  touch();
                }}
              />
              <TextField
                id="invoice-due"
                label="Payment due date"
                type="date"
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
            <fieldset className="flex flex-wrap items-center gap-4">
              <legend className="mb-2 font-medium">Prices entered</legend>
              {(["exclusive", "inclusive"] as const).map((mode) => (
                <label key={mode} className="flex min-h-11 items-center gap-2">
                  <input
                    type="radio"
                    name="price-entry"
                    value={mode}
                    checked={priceEntry === mode}
                    onChange={() => {
                      setPriceEntry(mode);
                      touch();
                    }}
                  />
                  {mode === "exclusive" ? "Ex GST" : "Incl GST"}
                </label>
              ))}
            </fieldset>
            {!registeredToday ? (
              <p className="text-sm text-muted-foreground">
                Not registered for GST today: no line can be Taxable, and no GST
                is charged.
              </p>
            ) : null}
            <ol className="space-y-4">
              {lines.map((line, index) => {
                const savedLine = !dirty ? saved?.lines[index] : undefined;
                return (
                  <li
                    key={line.key}
                    className="space-y-3 rounded-lg border p-4"
                  >
                    <fieldset className="space-y-3">
                      <legend className="font-semibold">
                        Line {index + 1}
                      </legend>
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
                      <div className="grid gap-3 sm:grid-cols-4">
                        <TextField
                          id={`${line.key}-quantity`}
                          label="Quantity (required)"
                          inputMode="decimal"
                          value={line.quantity}
                          error={lineError(index, "quantity")}
                          onChange={(event) =>
                            update(line.key, { quantity: event.target.value })
                          }
                        />
                        <TextField
                          id={`${line.key}-unit`}
                          label="Unit (optional)"
                          maxLength={20}
                          value={line.unit}
                          error={lineError(index, "unit")}
                          onChange={(event) =>
                            update(line.key, { unit: event.target.value })
                          }
                        />
                        <TextField
                          id={`${line.key}-price`}
                          label={`Unit price (${priceEntry === "exclusive" ? "ex" : "incl"} GST)`}
                          inputMode="decimal"
                          value={line.price}
                          error={lineError(index, "unitPriceCents")}
                          onChange={(event) =>
                            update(line.key, { price: event.target.value })
                          }
                        />
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
                                update(line.key, {
                                  taxCode: event.target.value as TaxCode,
                                })
                              }
                            >
                              {TAX_CODE_OPTIONS.map((option) => (
                                <option
                                  key={option.value}
                                  value={option.value}
                                  disabled={
                                    option.value === "TAXABLE_10" &&
                                    !registeredToday
                                  }
                                >
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </Field>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {
                          TAX_CODE_OPTIONS.find((o) => o.value === line.taxCode)
                            ?.help
                        }
                      </p>
                      {savedLine ? (
                        <p className="text-sm tabular-nums">
                          Saved:{" "}
                          {formatAudCents(BigInt(savedLine.exclusiveCents))} ex
                          GST · {taxLabel(savedLine.taxCode)} ·{" "}
                          {formatAudCents(BigInt(savedLine.gstCents))} GST ·{" "}
                          {formatAudCents(BigInt(savedLine.inclusiveCents))}{" "}
                          incl GST
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Line amounts appear after you save.
                        </p>
                      )}
                      {lines.length > 1 ? (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            setRemoved({ line, index });
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
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={lines.length >= 200}
                onClick={() => {
                  const line = blankLine(nextKey(), registeredToday);
                  setLines((current) => [...current, line]);
                  touch();
                  requestAnimationFrame(() =>
                    document.getElementById(`${line.key}-description`)?.focus(),
                  );
                }}
              >
                Add line
              </Button>
              {removed ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setLines((current) => {
                      const next = [...current];
                      next.splice(removed.index, 0, removed.line);
                      return next;
                    });
                    setRemoved(null);
                    touch();
                  }}
                >
                  Undo remove
                </Button>
              ) : null}
            </div>
          </fieldset>

          <fieldset disabled={busy} className="rounded-lg border bg-card p-6">
            <legend className="text-xl font-semibold">Notes</legend>
            <Field
              id="invoice-notes"
              label="Notes / payment instructions"
              error={errors.notes}
            >
              {(control) => (
                <textarea
                  {...control}
                  className={`${control.className} min-h-28 py-3`}
                  maxLength={2000}
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save draft"}
            </Button>
            {saved ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Discard this draft? It can't be recovered.",
                    )
                  )
                    return;
                  setBusy(true);
                  const response = await fetch(`/api/invoices/${saved.id}`, {
                    method: "DELETE",
                  }).catch(() => null);
                  setBusy(false);
                  if (!response?.ok) {
                    setMessage({
                      kind: "error",
                      text: "Couldn't discard the draft. Try again.",
                    });
                    return;
                  }
                  setDirty(false);
                  router.push("/invoices");
                }}
              >
                Discard draft
              </Button>
            ) : null}
          </div>
        </form>
        <aside className="space-y-4">
          <Totals
            totals={saved}
            stale={dirty && Boolean(saved)}
            registered={registeredToday}
          />
        </aside>
      </div>
      {saved ? (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:hidden">
          <span className="tabular-nums">
            Total incl GST{" "}
            {dirty ? "(unsaved)" : formatAudCents(BigInt(saved.inclusiveCents))}
          </span>
          <a
            className="inline-flex min-h-11 items-center underline"
            href="#totals"
          >
            View breakdown
          </a>
        </div>
      ) : null}
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/invoices"
        >
          Back to invoices
        </Link>
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="issue-heading"
        className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border bg-card p-6 text-card-foreground backdrop:bg-black/50"
        onClose={() => reviewButton.current?.focus()}
      >
        {saved ? (
          <div className="space-y-4">
            <h2 id="issue-heading" className="text-xl font-semibold">
              Issue {title.toLowerCase()}?
            </h2>
            <dl className="grid grid-cols-2 gap-2">
              <dt>Customer</dt>
              <dd>{customer.data?.name ?? "—"}</dd>
              <dt>Due</dt>
              <dd>{saved.dueOn ?? "No due date"}</dd>
              <dt>Subtotal</dt>
              <dd className="tabular-nums">
                {formatAudCents(BigInt(saved.exclusiveCents))} ex GST
              </dd>
              <dt>GST</dt>
              <dd className="tabular-nums">
                {formatAudCents(BigInt(saved.gstCents))}
              </dd>
              <dt>Total</dt>
              <dd className="font-semibold tabular-nums">
                {formatAudCents(BigInt(saved.inclusiveCents))} incl GST
              </dd>
            </dl>
            <TextField
              id="issue-date"
              label="Issue date (Australia/Sydney)"
              type="date"
              max={today}
              value={issueDate}
              onChange={(event) => setIssueDate(event.target.value)}
            />
            <p className="text-sm">
              Issuing assigns a number and preserves this document. Corrections
              require a credit note or a void. The title and GST follow your
              registration on the issue date.
            </p>
            {issueErrors.length ? (
              <div
                role="alert"
                className="rounded-lg bg-danger p-3 text-danger-foreground"
              >
                <ul className="list-disc pl-6">
                  {issueErrors.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                ref={cancelIssue}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => void issue()}
              >
                {busy
                  ? "Issuing…"
                  : `Issue ${isCredit ? "credit note" : title.toLowerCase()}`}
              </Button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
