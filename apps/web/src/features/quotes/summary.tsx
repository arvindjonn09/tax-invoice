import { MoneyDisplay, formatAudCents } from "@/components/money-display";
import { type Quote, percent } from "./types";

/**
 * Server-confirmed totals and the internal estimate. Revenue and profit are
 * GST-exclusive; the estimate is office-only and never sent to the customer.
 */
export function QuoteSummary({
  quote,
  stale,
}: {
  quote: Quote | null;
  stale: boolean;
}) {
  return (
    <div className="space-y-4">
      <section
        id="totals"
        aria-labelledby="quote-totals-heading"
        className="space-y-3 rounded-lg border bg-card p-6"
      >
        <h2 id="quote-totals-heading" className="text-xl font-semibold">
          Totals · AUD
        </h2>
        {!quote ? (
          <p>Total unavailable. Save the draft to calculate totals.</p>
        ) : (
          <>
            {stale ? (
              <p
                role="status"
                className="rounded-sm bg-warning p-3 text-warning-foreground"
              >
                Unsaved changes: these totals are from the last save.
              </p>
            ) : null}
            <dl className="space-y-2">
              <div className="flex justify-between gap-4">
                <dt className="shrink-0">Subtotal</dt>
                <dd>
                  <MoneyDisplay
                    cents={BigInt(quote.exclusiveCents)}
                    basis="ex GST"
                  />
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="shrink-0">GST</dt>
                <dd className="tabular-nums">
                  {quote.gstRegistered === false
                    ? "No GST charged"
                    : `${formatAudCents(BigInt(quote.gstCents))} AUD`}
                </dd>
              </div>
              <div className="flex justify-between gap-4 text-lg font-semibold">
                <dt className="shrink-0">Total</dt>
                <dd>
                  <MoneyDisplay
                    cents={BigInt(quote.inclusiveCents)}
                    basis="incl GST"
                  />
                </dd>
              </div>
            </dl>
          </>
        )}
      </section>
      {quote ? (
        <section
          aria-labelledby="estimate-heading"
          className="space-y-3 rounded-lg border bg-card p-6"
        >
          <h2 id="estimate-heading" className="text-xl font-semibold">
            Internal estimate
          </h2>
          <p className="text-sm text-muted-foreground">
            Office only — never shown to the customer. All ex GST.
          </p>
          <dl className="space-y-2">
            <div className="flex justify-between gap-4">
              <dt className="shrink-0">Estimated revenue</dt>
              <dd className="tabular-nums">
                {formatAudCents(BigInt(quote.estimate.revenueExclusiveCents))}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="shrink-0">Estimated cost</dt>
              <dd className="tabular-nums">
                {formatAudCents(BigInt(quote.estimate.costCents))}
              </dd>
            </div>
            <div className="flex justify-between gap-4 font-semibold">
              <dt className="shrink-0">Estimated profit</dt>
              <dd className="tabular-nums">
                {formatAudCents(BigInt(quote.estimate.profitCents))} ·{" "}
                {percent(quote.estimate.marginBasisPoints)} margin
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
