"use client";
import { type TaxCode, expenseLine } from "@jobflow/domain";
import { formatAudCents } from "@/components/money-display";
/**
 * GST breakdown of one receipt line. While editing it is previewed with the
 * same domain calculation the server stores; after saving, pass the server's
 * cents instead. Always rendered, so GST is never hidden (#41).
 */
export function GstBreakdown({
  amounts,
  label = "GST breakdown",
}: {
  amounts: { exclusive: bigint; gst: bigint; inclusive: bigint } | null;
  label?: string;
}) {
  const show = (cents: bigint | undefined) =>
    cents === undefined ? "—" : `${formatAudCents(cents)} AUD`;
  return (
    <section
      aria-label={label}
      className="rounded-lg border bg-muted p-4 text-muted-foreground"
    >
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm">Ex GST</dt>
          <dd className="money font-semibold text-foreground">
            {show(amounts?.exclusive)}
          </dd>
        </div>
        <div>
          <dt className="text-sm">GST</dt>
          <dd className="money font-semibold text-foreground">
            {show(amounts?.gst)}
          </dd>
        </div>
        <div>
          <dt className="text-sm">Incl GST</dt>
          <dd className="money font-semibold text-foreground">
            {show(amounts?.inclusive)}
          </dd>
        </div>
      </dl>
      {amounts ? null : (
        <p className="mt-2 text-sm">Enter an amount to see its GST.</p>
      )}
    </section>
  );
}
/** Preview amounts for entered cents; null when nothing valid is entered. */
export function previewAmounts(
  cents: string | null,
  priceEntry: "exclusive" | "inclusive",
  taxCode: TaxCode,
) {
  if (cents === null) return null;
  return expenseLine({ amount: BigInt(cents), priceEntry, taxCode });
}
/** Server-calculated cents strings, as bigint amounts. */
export function savedAmounts(row: {
  exclusiveCents: string;
  gstCents: string;
  inclusiveCents: string;
}) {
  return {
    exclusive: BigInt(row.exclusiveCents),
    gst: BigInt(row.gstCents),
    inclusive: BigInt(row.inclusiveCents),
  };
}
