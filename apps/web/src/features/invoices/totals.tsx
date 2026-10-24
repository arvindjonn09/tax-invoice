import { MoneyDisplay, formatAudCents } from "@/components/money-display";

/**
 * Totals exactly as the server last confirmed them. Unsaved edits mark them
 * stale; with no confirmed totals there is nothing to show ("Total
 * unavailable"), never a fabricated $0.00.
 */
export function Totals({
  totals,
  stale,
  registered,
}: {
  totals: {
    exclusiveCents: string;
    gstCents: string;
    inclusiveCents: string;
  } | null;
  stale: boolean;
  registered: boolean | null;
}) {
  return (
    <section
      id="totals"
      aria-labelledby="totals-heading"
      className="space-y-3 rounded-lg border bg-card p-6"
    >
      <h2 id="totals-heading" className="text-xl font-semibold">
        Totals · AUD
      </h2>
      {!totals ? (
        <p>Total unavailable. Save the draft to calculate totals.</p>
      ) : (
        <>
          {stale ? (
            <p
              role="status"
              className="rounded-sm bg-warning p-3 text-warning-foreground"
            >
              Unsaved changes: these totals are from the last save. Save the
              draft to recalculate.
            </p>
          ) : null}
          <dl className="space-y-2">
            <div className="flex justify-between gap-4">
              <dt className="shrink-0">Subtotal</dt>
              <dd>
                <MoneyDisplay
                  cents={BigInt(totals.exclusiveCents)}
                  basis="ex GST"
                />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="shrink-0">GST</dt>
              <dd className="tabular-nums">
                {registered === false
                  ? "No GST charged"
                  : `${formatAudCents(BigInt(totals.gstCents))} AUD`}
              </dd>
            </div>
            <div className="flex justify-between gap-4 text-lg font-semibold">
              <dt className="shrink-0">Total</dt>
              <dd>
                <MoneyDisplay
                  cents={BigInt(totals.inclusiveCents)}
                  basis="incl GST"
                />
              </dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
