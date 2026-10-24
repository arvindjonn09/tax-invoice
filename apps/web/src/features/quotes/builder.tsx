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
import { QuoteSummary } from "./summary";
import { type Quote, TAX_CODE_OPTIONS, type TaxCode, taxLabel } from "./types";

type DraftLine = {
  key: string;
  description: string;
  quantity: string;
  unit: string;
  price: string;
  cost: string;
  taxCode: TaxCode;
};

/** Jobs a quote may attach to, and jobs a variation may change. */
const QUOTE_JOBS = "draft,quoted";
const VARIATION_JOBS =
  "approved,assigned,in_progress,awaiting_review,completed,invoiced";

const blankLine = (key: string, registered: boolean): DraftLine => ({
  key,
  description: "",
  quantity: "1",
  unit: "",
  price: "",
  cost: "",
  taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
});

function cents(text: string, required: boolean): string | null | undefined {
  if (!text.trim()) return required ? null : undefined;
  try {
    return parseAudInput(text);
  } catch {
    return null;
  }
}

/** A draft quote or variation. Totals and the estimate come from the server. */
export function QuoteBuilder({
  initial,
  registeredToday,
  today,
  onSent,
}: {
  initial: Quote | null;
  registeredToday: boolean;
  today: string;
  onSent?: (quote: Quote) => void;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<Quote | null>(initial);
  const [kind, setKind] = useState<"quote" | "variation">(
    initial?.kind ?? "quote",
  );
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [jobId, setJobId] = useState(initial?.jobId ?? "");
  const [locationId, setLocationId] = useState(initial?.locationId ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [scope, setScope] = useState(initial?.scope ?? "");
  const [validUntil, setValidUntil] = useState(initial?.validUntil ?? "");
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
          cost:
            line.estimatedCostCents === "0"
              ? ""
              : audInput(line.estimatedCostCents),
          taxCode: line.taxCode,
        }))
      : [blankLine("line-0", registeredToday)],
  );
  const keyCounter = useRef(Math.max(1, initial?.lines.length ?? 0));
  const [dirty, setDirty] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [sentOn, setSentOn] = useState(today);
  const [sendErrors, setSendErrors] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelSend = useRef<HTMLButtonElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  useUnsavedChanges(dirty);
  const focusSummary = () =>
    requestAnimationFrame(() => summary.current?.focus());

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
  // Eligibility is filtered server-side before pagination, so older jobs
  // stay reachable through search and paging.
  const [jobQuery, setJobQuery] = useState("");
  const [jobPage, setJobPage] = useState(1);
  const [jobLabel, setJobLabel] = useState("");
  const jobs = useRemote<{
    total: number;
    pageSize: number;
    jobs: { id: string; reference: string; title: string }[];
  }>(
    customerId && !saved
      ? `/api/jobs?${new URLSearchParams({
          customerId,
          status: kind === "variation" ? VARIATION_JOBS : QUOTE_JOBS,
          q: jobQuery,
          page: String(jobPage),
          pageSize: "20",
        })}`
      : null,
  );
  const eligibleJobs = jobs.data?.jobs;
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

  async function save(): Promise<void> {
    const local: Record<string, string> = {};
    const body = lines.map((line, index) => {
      const price = cents(line.price, true);
      const cost = cents(line.cost, false);
      if (price === null)
        local[`lines.${index}.unitPriceCents`] =
          `Enter a valid AUD amount with at most two decimal places for line ${index + 1}.`;
      if (cost === null)
        local[`lines.${index}.estimatedCostCents`] =
          `Enter a valid AUD estimate with at most two decimal places for line ${index + 1}.`;
      return {
        description: line.description,
        quantity: line.quantity,
        unit: line.unit.trim() || null,
        unitPriceCents: price ?? "0",
        taxCode: line.taxCode,
        ...(cost ? { estimatedCostCents: cost } : {}),
      };
    });
    if (!saved && !customerId) local.customerId = "Select a customer.";
    if (!saved && kind === "variation" && !jobId)
      local.jobId = "Choose the job this variation changes.";
    if (Object.keys(local).length) {
      setErrors(local);
      setMessage({ kind: "error", text: "Fix the highlighted fields." });
      focusSummary();
      return;
    }
    setBusy(true);
    const result = await sendJson(
      saved ? `/api/quotes/${saved.id}` : "/api/quotes",
      saved ? "PATCH" : "POST",
      {
        ...(saved ? {} : { customerId, kind, jobId: jobId || null }),
        locationId: locationId || null,
        title,
        scope: scope.trim() || null,
        validUntil: validUntil || null,
        notes: notes.trim() || null,
        priceEntry,
        lines: body,
      },
    );
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fields);
      setMessage({ kind: "error", text: result.message });
      focusSummary();
      return;
    }
    const next = result.body as Quote;
    setSaved(next);
    setErrors({});
    setDirty(false);
    setMessage({ kind: "success", text: "Draft saved." });
    if (!saved) window.history.replaceState(null, "", `/quotes/${next.id}`);
  }

  async function send() {
    if (!saved || dirty) return;
    setBusy(true);
    setSendErrors([]);
    const result = await sendJson(`/api/quotes/${saved.id}/send`, "POST", {
      sentOn,
    });
    setBusy(false);
    if (!result.ok) {
      setSendErrors([
        result.message,
        ...Object.values(result.fields).filter((t) => t !== result.message),
      ]);
      return;
    }
    dialog.current?.close();
    if (onSent) onSent(result.body as Quote);
    else router.replace(`/quotes/${saved.id}?sent=1`);
  }

  const errorList = Object.entries(errors);
  const lineError = (index: number, field: string) =>
    errors[`lines.${index}.${field}`];
  const label = saved
    ? `${saved.kind === "variation" ? "Variation" : "Quote"} ${saved.reference}`
    : "New quote";
  return (
    <>
      <PageHeader
        title={label}
        description="Draft · not sent to the customer"
        breadcrumbs={[{ label: "Quotes", href: "/quotes" }, { label }]}
        actions={
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save draft"}
            </Button>
            <Button
              ref={sendButton}
              disabled={busy || dirty || !saved || !saved.lines.length}
              onClick={() => {
                setSendErrors([]);
                dialog.current?.showModal();
                cancelSend.current?.focus();
              }}
            >
              Review and send
            </Button>
          </div>
        }
      />
      {dirty || !saved ? (
        <p className="text-sm text-muted-foreground">
          Save the draft before sending: sending freezes the server-confirmed
          prices.
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
            <legend className="text-xl font-semibold">Customer and work</legend>
            {saved ? (
              <p>
                Customer: <strong>{customer.data?.name ?? "Loading…"}</strong>
                {saved.jobId ? (
                  <>
                    {" "}
                    ·{" "}
                    <Link className="underline" href={`/jobs/${saved.jobId}`}>
                      Linked job
                    </Link>
                  </>
                ) : null}
              </p>
            ) : (
              <>
                <Field id="quote-kind" label="Type">
                  {(control) => (
                    <select
                      {...control}
                      value={kind}
                      onChange={(event) => {
                        setKind(event.target.value as "quote" | "variation");
                        setJobId("");
                        setJobPage(1);
                        touch();
                      }}
                    >
                      <option value="quote">Quote (new work)</option>
                      <option value="variation">
                        Variation to an approved job
                      </option>
                    </select>
                  )}
                </Field>
                <EntityPicker
                  kind="customers"
                  id="quote-customer"
                  label="Customer (required)"
                  value={customerId}
                  onChange={(id) => {
                    setCustomerId(id);
                    setJobId("");
                    setJobPage(1);
                    setLocationId("");
                    touch();
                  }}
                  error={errors.customerId}
                />
                <Field
                  id="quote-job"
                  label={
                    kind === "variation"
                      ? "Job (required)"
                      : "Existing draft job (optional)"
                  }
                  hint={
                    kind === "variation"
                      ? "Accepting the variation adds its ex-GST amount to the job."
                      : "Leave empty to create a job when the quote is accepted."
                  }
                  error={errors.jobId}
                >
                  {(control) => (
                    <select
                      {...control}
                      value={jobId}
                      disabled={!customerId}
                      onChange={(event) => {
                        const job = eligibleJobs?.find(
                          (row) => row.id === event.target.value,
                        );
                        setJobLabel(
                          job ? `${job.reference} · ${job.title}` : "",
                        );
                        setJobId(event.target.value);
                        touch();
                      }}
                    >
                      <option value="">
                        {kind === "variation"
                          ? "Choose a job"
                          : "Create a job on acceptance"}
                      </option>
                      {jobId &&
                      !eligibleJobs?.some((job) => job.id === jobId) ? (
                        <option value={jobId}>
                          {jobLabel || "Selected job"}
                        </option>
                      ) : null}
                      {eligibleJobs?.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.reference} · {job.title}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {customerId ? (
                  <div className="space-y-3">
                    <TextField
                      id="quote-job-search"
                      label="Find job"
                      hint="Search this customer's eligible jobs by number or title."
                      maxLength={100}
                      value={jobQuery}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                      }}
                      onChange={(event) => {
                        setJobQuery(event.target.value);
                        setJobPage(1);
                      }}
                    />
                    {jobs.error ? (
                      <div role="alert">
                        <p>{jobs.error}</p>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={jobs.reload}
                        >
                          Retry job search
                        </Button>
                      </div>
                    ) : jobs.data ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-sm text-muted-foreground">
                          {jobs.data.total} eligible{" "}
                          {jobs.data.total === 1 ? "job" : "jobs"} · page{" "}
                          {jobPage} of{" "}
                          {Math.max(
                            1,
                            Math.ceil(jobs.data.total / jobs.data.pageSize),
                          )}
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={jobPage === 1}
                          onClick={() => setJobPage((value) => value - 1)}
                          aria-label="Previous jobs"
                        >
                          Previous
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            jobPage * jobs.data.pageSize >= jobs.data.total
                          }
                          onClick={() => setJobPage((value) => value + 1)}
                          aria-label="Next jobs"
                        >
                          Next
                        </Button>
                      </div>
                    ) : (
                      <p role="status">Loading jobs…</p>
                    )}
                  </div>
                ) : null}
              </>
            )}
            <Field
              id="quote-site"
              label="Site (optional)"
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
                  {customer.data?.locations
                    .filter(
                      (site) => !site.archivedAt || site.id === locationId,
                    )
                    .map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.label ?? site.addressLine1} · {site.suburb}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <TextField
              id="quote-title"
              label="Title (required)"
              maxLength={200}
              value={title}
              error={errors.title}
              onChange={(event) => {
                setTitle(event.target.value);
                touch();
              }}
            />
            <Field id="quote-scope" label="Scope of work" error={errors.scope}>
              {(control) => (
                <textarea
                  {...control}
                  className={`${control.className} min-h-28 py-3`}
                  maxLength={4000}
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value);
                    touch();
                  }}
                />
              )}
            </Field>
            <TextField
              id="quote-valid"
              label="Valid until"
              type="date"
              min={today}
              value={validUntil}
              error={errors.validUntil}
              onChange={(event) => {
                setValidUntil(event.target.value);
                touch();
              }}
            />
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
                    name="quote-price-entry"
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
                Not registered for GST today: no line can be Taxable.
              </p>
            ) : null}
            <ol className="space-y-4">
              {lines.map((line, index) => {
                const savedLine = !dirty ? saved?.lines[index] : undefined;
                return (
                  <li key={line.key} className="rounded-lg border p-4">
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
                      <div className="grid gap-3 sm:grid-cols-3">
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
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
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
                        <TextField
                          id={`${line.key}-cost`}
                          label="Estimated cost, ex GST (internal)"
                          hint="For this whole line. Never shown to the customer."
                          inputMode="decimal"
                          value={line.cost}
                          error={lineError(index, "estimatedCostCents")}
                          onChange={(event) =>
                            update(line.key, { cost: event.target.value })
                          }
                        />
                      </div>
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
              disabled={lines.length >= 200}
              onClick={() => {
                const line = blankLine(
                  `line-${keyCounter.current++}`,
                  registeredToday,
                );
                setLines((current) => [...current, line]);
                touch();
                requestAnimationFrame(() =>
                  document.getElementById(`${line.key}-description`)?.focus(),
                );
              }}
            >
              Add line
            </Button>
          </fieldset>
          <fieldset disabled={busy} className="rounded-lg border bg-card p-6">
            <legend className="text-xl font-semibold">Notes</legend>
            <Field
              id="quote-notes"
              label="Notes for the customer"
              error={errors.notes}
            >
              {(control) => (
                <textarea
                  {...control}
                  className={`${control.className} min-h-24 py-3`}
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
                  const response = await fetch(`/api/quotes/${saved.id}`, {
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
                  router.push("/quotes");
                }}
              >
                Discard draft
              </Button>
            ) : null}
          </div>
        </form>
        <aside>
          <QuoteSummary quote={saved} stale={dirty && Boolean(saved)} />
        </aside>
      </div>
      <p>
        <Link
          className="inline-flex min-h-11 items-center underline"
          href="/quotes"
        >
          Back to quotes
        </Link>
      </p>
      <dialog
        ref={dialog}
        aria-labelledby="send-heading"
        className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border bg-card p-6 text-card-foreground backdrop:bg-black/50"
        onClose={() => sendButton.current?.focus()}
      >
        {saved ? (
          <div className="space-y-4">
            <h2 id="send-heading" className="text-xl font-semibold">
              Send {saved.reference}?
            </h2>
            <p>
              {saved.title} · {formatAudCents(BigInt(saved.inclusiveCents))}{" "}
              incl GST
              {saved.validUntil ? ` · valid until ${saved.validUntil}` : ""}
            </p>
            <TextField
              id="quote-sent-on"
              label="Sent on (Australia/Sydney)"
              type="date"
              max={today}
              value={sentOn}
              onChange={(event) => setSentOn(event.target.value)}
            />
            <p className="text-sm">
              Sending freezes the prices and GST as at the send date. To change
              it afterwards, revise the quote.
            </p>
            {sendErrors.length ? (
              <div
                role="alert"
                className="rounded-lg bg-danger p-3 text-danger-foreground"
              >
                <ul className="list-disc pl-6">
                  {sendErrors.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                ref={cancelSend}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </Button>
              <Button type="button" disabled={busy} onClick={() => void send()}>
                {busy ? "Sending…" : "Mark as sent"}
              </Button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
