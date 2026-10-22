import { type Cents, divideRounded, sum } from "./money";

/** GST treatment of a line (docs/GST.md). Zero-rated codes stay distinct. */
export type TaxCode =
  "TAXABLE_10" | "GST_FREE" | "INPUT_TAXED" | "OUT_OF_SCOPE";

export const TAX_CODES: readonly TaxCode[] = [
  "TAXABLE_10",
  "GST_FREE",
  "INPUT_TAXED",
  "OUT_OF_SCOPE",
];

/** Rate in basis points, snapshotted onto every line (10% = 1000). */
export function gstRateBasisPoints(taxCode: TaxCode): bigint {
  return taxCode === "TAXABLE_10" ? 1000n : 0n;
}

export type PriceEntry = "exclusive" | "inclusive";

export type GstLine = {
  taxCode: TaxCode;
  rateBasisPoints: bigint;
  exclusive: Cents;
  gst: Cents;
  inclusive: Cents;
};

const QUANTITY = /^(\d{1,9})(?:\.(\d{1,4}))?$/;

/** Parse a positive decimal quantity (up to 4 dp) without floating point. */
export function parseQuantity(quantity: string): {
  units: bigint;
  scale: bigint;
} {
  const match = QUANTITY.exec(quantity);
  if (!match) throw new RangeError(`Invalid quantity "${quantity}"`);
  const decimals = match[2] ?? "";
  const units = BigInt(`${match[1]}${decimals}`);
  if (units === 0n) throw new RangeError("Quantity must be greater than zero");
  return { units, scale: 10n ** BigInt(decimals.length) };
}

/** Quantity × unit price, aggregated before GST rounding (R3). */
export function lineAmount(quantity: string, unitPrice: Cents): Cents {
  const { units, scale } = parseQuantity(quantity);
  return divideRounded(unitPrice * units, scale);
}

/**
 * GST for one supply line (R2, R3): per-line rounding, halves up.
 * Exclusive entry: gst = round(ex × rate); inclusive entry: gst = round(inc × rate / (1 + rate)).
 * An unregistered supplier cannot charge GST (R1).
 */
export function calculateSupplyLine(input: {
  quantity: string;
  unitPrice: Cents;
  priceEntry: PriceEntry;
  taxCode: TaxCode;
  supplierRegistered: boolean;
}): GstLine {
  if (!input.supplierRegistered && input.taxCode === "TAXABLE_10") {
    throw new RangeError("A supplier not registered for GST cannot charge GST");
  }
  const amount = lineAmount(input.quantity, input.unitPrice);
  const rate = gstRateBasisPoints(input.taxCode);
  if (input.priceEntry === "exclusive") {
    const gst = divideRounded(amount * rate, 10_000n);
    return {
      taxCode: input.taxCode,
      rateBasisPoints: rate,
      exclusive: amount,
      gst,
      inclusive: amount + gst,
    };
  }
  const gst = divideRounded(amount * rate, 10_000n + rate);
  return {
    taxCode: input.taxCode,
    rateBasisPoints: rate,
    exclusive: amount - gst,
    gst,
    inclusive: amount,
  };
}

export type DocumentTotals = {
  exclusive: Cents;
  gst: Cents;
  inclusive: Cents;
};

/** Document totals are sums of rounded lines, never a re-rounded whole (R3). */
export function documentTotals(lines: readonly GstLine[]): DocumentTotals {
  return {
    exclusive: sum(lines.map((line) => line.exclusive)),
    gst: sum(lines.map((line) => line.gst)),
    inclusive: sum(lines.map((line) => line.inclusive)),
  };
}

/** A credit note line reversing the original line's exact cents (R9). */
export function reverseLine(line: GstLine): GstLine {
  return {
    ...line,
    exclusive: -line.exclusive,
    gst: -line.gst,
    inclusive: -line.inclusive,
  };
}
