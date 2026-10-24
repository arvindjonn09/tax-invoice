"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField, FormMessage, sendJson } from "@/components/form/field";
import { useRemote } from "@/components/data/use-remote";
import { formatAudCents } from "@/components/money-display";
import { parseAudInput } from "@/lib/aud-input";
import type { EmployeeRate } from "./types";

/**
 * Append-only cost-rate history (#38). A timesheet is costed once, when it's
 * approved, at the rate in effect on its work date; approved timesheets keep
 * that snapshot, so adding a rate never changes past costs.
 */
export function RateHistory({
  employeeId,
  editable,
  today,
}: {
  employeeId: string;
  editable: boolean;
  today: string;
}) {
  const { data, error, reload } = useRemote<{ rates: EmployeeRate[] }>(
    `/api/employees/${employeeId}/rates`,
  );
  const [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState<{
      kind: "error" | "success";
      text: string;
    } | null>(null);
  // Newest start date first, so the first one already started is current.
  const current = data?.rates.find((rate) => rate.effectiveFrom <= today);
  return (
    <section
      aria-labelledby="rates-heading"
      className="space-y-4 rounded-lg border bg-card p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="rates-heading" className="text-xl font-semibold">
          Cost rate history
        </h2>
        {editable && !adding ? (
          <Button
            onClick={() => {
              setAdding(true);
              setMessage(null);
            }}
          >
            Add rate
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Internal hourly labour cost used for job costing — not a charge-out
        price, and no GST applies. Rates can&apos;t be edited or removed: add a
        new rate from a start date instead. Timesheets already approved keep the
        cost they were approved at.
      </p>
      <FormMessage message={message} />
      {adding ? (
        <form
          className="space-y-4 rounded-lg border p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const form = new FormData(event.currentTarget);
            let cents: string | null = null;
            try {
              cents = parseAudInput(String(form.get("hourlyCost") ?? ""));
            } catch (failure) {
              if (!(failure instanceof RangeError)) throw failure;
            }
            if (cents === null) {
              setErrors({
                hourlyCostCents:
                  "Enter a non-negative AUD amount with at most two decimal places.",
              });
              return;
            }
            setBusy(true);
            const result = await sendJson(
              `/api/employees/${employeeId}/rates`,
              "POST",
              {
                effectiveFrom: form.get("effectiveFrom"),
                hourlyCostCents: cents,
              },
            );
            setBusy(false);
            if (!result.ok) {
              setErrors(result.fields);
              setMessage({ kind: "error", text: result.message });
              return;
            }
            setErrors({});
            setAdding(false);
            setMessage({ kind: "success", text: "Cost rate added." });
            reload();
          }}
        >
          <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
            <legend className="font-semibold">New cost rate</legend>
            <TextField
              id="rate-effective-from"
              name="effectiveFrom"
              label="Starts on *"
              type="date"
              required
              defaultValue={today}
              error={errors.effectiveFrom}
            />
            <TextField
              id="rate-hourly-cost"
              name="hourlyCost"
              label="Hourly cost (AUD) *"
              hint="For example 55.00"
              inputMode="decimal"
              required
              maxLength={16}
              error={errors.hourlyCostCents}
            />
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save rate"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setErrors({});
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <p role="status">Loading cost rates…</p>
      ) : data.rates.length ? (
        <ul className="divide-y rounded-lg border">
          {data.rates.map((rate) => (
            <li
              key={rate.id}
              className="flex flex-wrap items-baseline justify-between gap-2 p-4"
            >
              <span>
                From {rate.effectiveFrom}
                {rate === current ? (
                  <strong className="ml-2">Current</strong>
                ) : rate.effectiveFrom > today ? (
                  <span className="ml-2 text-muted-foreground">Upcoming</span>
                ) : null}
              </span>
              <span className="font-medium tabular-nums">
                {formatAudCents(BigInt(rate.hourlyCostCents))} AUD an hour
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No cost rate yet. Timesheets for this employee can&apos;t be approved
          until a rate covers their work date.
        </p>
      )}
    </section>
  );
}
