"use client";
import Link from "next/link";
import { useState } from "react";
import { useRemote } from "@/components/data/use-remote";
import { useUnsavedChanges } from "@/components/form/use-unsaved-changes";
import {
  Field,
  TextField,
  FormMessage,
  sendJson,
} from "@/components/form/field";
import { Button } from "@/components/ui/button";
import { MoneyDisplay, formatAudCents } from "@/components/money-display";
import { parseAudInput, audInput } from "@/lib/aud-input";
import { time } from "@/features/jobs/types";
import type { Contractor, Offer } from "./types";
function JobPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [q, setQ] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState("");
  const { data, error, reload } = useRemote<{
    jobs: { id: string; reference: string; title: string; status: string }[];
    total: number;
    pageSize: number;
  }>(
    `/api/jobs?${new URLSearchParams({ q, page: String(page), pageSize: "20" })}`,
  );
  const rows = data?.jobs ?? [];
  return (
    <div className="space-y-3">
      <TextField
        id="offer-job-search"
        label="Find job"
        value={q}
        maxLength={100}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />
      <Field id="offer-job" label="Job *">
        {(control) => (
          <select
            {...control}
            required
            value={value}
            onChange={(e) => {
              const row = rows.find((r) => r.id === e.target.value);
              setSelected(row ? `${row.reference} · ${row.title}` : "");
              onChange(e.target.value);
            }}
          >
            <option value="">Choose job</option>
            {value && !rows.some((r) => r.id === value) ? (
              <option value={value}>{selected}</option>
            ) : null}
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.reference} · {row.title} ({row.status})
              </option>
            ))}
          </select>
        )}
      </Field>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button type="button" variant="outline" onClick={reload}>
            Retry job search
          </Button>
        </div>
      ) : !data ? (
        <p role="status">Loading jobs…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Page {page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((p) => p - 1)}
            aria-label="Previous jobs"
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={page * data.pageSize >= data.total}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Next jobs"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
export function OfferEditor({
  contractor,
  initial,
  saved,
  cancel,
}: {
  contractor: Contractor;
  initial?: Offer;
  saved: () => void;
  cancel: () => void;
}) {
  const [jobId, setJobId] = useState(initial?.jobId ?? ""),
    [rateType, setRateType] = useState(initial?.rateType ?? "fixed");
  const [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<{ kind: "error"; text: string } | null>(
      null,
    );
  useUnsavedChanges(dirty);
  return (
    <form
      className="space-y-4"
      onChange={() => setDirty(true)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        const form = new FormData(e.currentTarget);
        let amount: string | null = null;
        try {
          amount = parseAudInput(String(form.get("rate")));
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
        }
        if (amount === null) {
          setErrors({
            rateExclusiveCents:
              "Enter a non-negative AUD amount with at most two decimal places.",
          });
          return;
        }
        setBusy(true);
        const result = await sendJson(
          `/api/jobs/${jobId}/offers${initial ? `/${initial.id}` : ""}`,
          initial ? "PATCH" : "POST",
          {
            ...(!initial ? { contractorId: contractor.id } : {}),
            scope: form.get("scope"),
            rateType,
            rateExclusiveCents: amount,
            estimatedHours:
              rateType === "hourly" ? String(form.get("hours")) : null,
            taxCode: form.get("taxCode"),
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
      <fieldset disabled={busy} className="space-y-4">
        <legend className="sr-only">Offer terms</legend>
        {!initial ? (
          <JobPicker value={jobId} onChange={setJobId} />
        ) : (
          <p>
            Job:{" "}
            <Link className="underline" href={`/jobs/${jobId}`}>
              View job
            </Link>
          </p>
        )}
        <Field id="offer-scope" label="Work scope *" error={errors.scope}>
          {(control) => (
            <textarea
              {...control}
              className={`${control.className} min-h-28 py-3`}
              name="scope"
              required
              maxLength={2000}
              defaultValue={initial?.scope}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="offer-rate-type" label="Rate type">
            {(control) => (
              <select
                {...control}
                value={rateType}
                onChange={(e) =>
                  setRateType(e.target.value as "fixed" | "hourly")
                }
              >
                <option value="fixed">Fixed price</option>
                <option value="hourly">Hourly rate</option>
              </select>
            )}
          </Field>
          <TextField
            id="offer-rate"
            name="rate"
            label={
              rateType === "fixed"
                ? "Fixed price (AUD ex GST) *"
                : "Hourly rate (AUD ex GST) *"
            }
            inputMode="decimal"
            required
            defaultValue={initial ? audInput(initial.rateExclusiveCents) : ""}
            error={errors.rateExclusiveCents}
          />
          {rateType === "hourly" ? (
            <TextField
              id="offer-hours"
              name="hours"
              label="Estimated hours *"
              required
              inputMode="decimal"
              pattern="[0-9]{1,4}(\.[0-9]{1,2})?"
              defaultValue={initial?.estimatedHours ?? ""}
              error={errors.estimatedHours}
            />
          ) : null}
          <Field id="offer-tax" label="Tax treatment" error={errors.taxCode}>
            {(control) => (
              <select
                {...control}
                name="taxCode"
                defaultValue={
                  initial?.taxCode ??
                  (contractor.gstRegistered ? "TAXABLE_10" : "OUT_OF_SCOPE")
                }
              >
                <option value="TAXABLE_10" disabled={!contractor.gstRegistered}>
                  Taxable · 10% GST
                </option>
                <option value="GST_FREE">GST-free</option>
                <option value="INPUT_TAXED">Input taxed</option>
                <option value="OUT_OF_SCOPE">Out of scope</option>
              </select>
            )}
          </Field>
        </div>
        <p className="text-sm text-muted-foreground">
          Rates exclude GST. Saving creates or updates the offer; the server
          calculates the GST and total shown in its summary. Acceptance records
          an immutable snapshot and a commitment, not a bill or payment.
        </p>
        {errors.jobId ? <p role="alert">{errors.jobId}</p> : null}
      </fieldset>
      <FormMessage message={message} />
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy || !jobId}>
          {busy ? "Saving…" : "Save offer"}
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
export function OfferHistory({
  offers,
  editable,
  edit,
  refresh,
}: {
  offers: Offer[];
  editable: boolean;
  edit: (offer: Offer) => void;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  return (
    <div className="space-y-4">
      <FormMessage message={message} />
      {!offers.length ? (
        <p>No offers yet. Create an offer to agree work on a job.</p>
      ) : (
        <ul className="space-y-4">
          {offers.map((offer) => (
            <li
              key={offer.id}
              className="min-w-0 space-y-3 rounded-lg border p-4 [overflow-wrap:anywhere]"
            >
              <div className="flex flex-wrap justify-between gap-3">
                <h3 className="font-semibold">
                  <Link className="underline" href={`/jobs/${offer.jobId}`}>
                    View job
                  </Link>{" "}
                  · {offer.status}
                </h3>
                <span>{time(offer.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap">{offer.scope}</p>
              <p>
                {offer.rateType === "fixed" ? "Fixed price" : "Hourly rate"}:{" "}
                <MoneyDisplay
                  cents={BigInt(offer.rateExclusiveCents)}
                  basis="ex GST"
                />
                {offer.estimatedHours ? ` · ${offer.estimatedHours} hours` : ""}{" "}
                · {offer.taxCode}
              </p>
              {offer.exclusiveCents !== null &&
              offer.gstCents !== null &&
              offer.inclusiveCents !== null ? (
                <dl className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <dt>Amount ex GST</dt>
                    <dd>
                      <MoneyDisplay
                        cents={BigInt(offer.exclusiveCents)}
                        basis="ex GST"
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>GST</dt>
                    <dd>{formatAudCents(BigInt(offer.gstCents))} AUD</dd>
                  </div>
                  <div>
                    <dt>Total incl GST</dt>
                    <dd>
                      <MoneyDisplay
                        cents={BigInt(offer.inclusiveCents)}
                        basis="incl GST"
                      />
                    </dd>
                  </div>
                </dl>
              ) : (
                <p role="status">
                  These terms no longer match the contractor&apos;s GST
                  registration. Update the offer before acceptance.
                </p>
              )}
              {offer.respondedAt ? (
                <p>
                  Response: {time(offer.respondedAt)}
                  {offer.responseNote ? ` · ${offer.responseNote}` : ""}
                </p>
              ) : null}
              {offer.acceptance ? (
                <div className="rounded-lg bg-muted p-4">
                  <h4 className="font-semibold">Accepted terms snapshot</h4>
                  <p>Accepted {time(offer.acceptance.acceptedAt)}</p>
                  <p>
                    Committed job cost:{" "}
                    {formatAudCents(
                      BigInt(offer.acceptance.committedCostCents),
                    )}{" "}
                    AUD (ex GST plus non-creditable GST)
                  </p>
                  <p className="text-sm">
                    Agreed costs are committed, not incurred or paid. Supplier
                    bills and payments follow in later releases.
                  </p>
                </div>
              ) : null}
              {editable && offer.status === "offered" ? (
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => edit(offer)}
                  >
                    Edit offer
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          "Withdraw this offer? It can no longer be accepted.",
                        )
                      )
                        return;
                      setBusy(offer.id);
                      const result = await sendJson(
                        `/api/jobs/${offer.jobId}/offers/${offer.id}`,
                        "PATCH",
                        { status: "withdrawn" },
                      );
                      setBusy(null);
                      if (!result.ok)
                        setMessage({ kind: "error", text: result.message });
                      else {
                        setMessage({
                          kind: "success",
                          text: "Offer withdrawn.",
                        });
                        refresh();
                      }
                    }}
                  >
                    {busy === offer.id ? "Withdrawing…" : "Withdraw offer"}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
