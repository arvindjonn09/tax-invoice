import {
  type PriceEntry,
  type TaxCode,
  calculateSupplyLine,
} from "@jobflow/domain";
import { audInput, parseAudInput } from "@/lib/aud-input";

type PricedLine = { quantity: string; price: string; taxCode: TaxCode };

const cents = (text: string): bigint | null => {
  try {
    const parsed = parseAudInput(text);
    return parsed === null ? null : BigInt(parsed);
  } catch {
    return null;
  }
};

/** A line's GST-inclusive total as entered, or null if it can't be priced. */
function lineTotal(line: PricedLine, entry: PriceEntry, registered: boolean) {
  const unitPrice = cents(line.price);
  if (unitPrice === null) return null;
  try {
    return calculateSupplyLine({
      quantity: line.quantity,
      unitPrice,
      priceEntry: entry,
      taxCode: line.taxCode,
      supplierRegistered: registered,
    }).inclusive;
  } catch {
    return null;
  }
}

/**
 * Switching between ex- and incl-GST entry keeps each line's commercial
 * amount: Taxable unit prices are converted with the domain GST rule
 * (other codes carry no GST, so their prices stand). `changed` lists lines
 * whose total moves by a rounding cent, for the user to confirm.
 */
export function convertEntryMode<T extends PricedLine>(
  lines: readonly T[],
  from: PriceEntry,
  to: PriceEntry,
  registered: boolean,
): {
  lines: T[];
  changed: { index: number; before: bigint; after: bigint }[];
} {
  if (from === to || !registered) return { lines: [...lines], changed: [] };
  const changed: { index: number; before: bigint; after: bigint }[] = [];
  const converted = lines.map((line, index) => {
    const unitPrice = cents(line.price);
    if (line.taxCode !== "TAXABLE_10" || unitPrice === null) return line;
    const unit = calculateSupplyLine({
      quantity: "1",
      unitPrice,
      priceEntry: from,
      taxCode: line.taxCode,
      supplierRegistered: true,
    });
    const next = {
      ...line,
      price: audInput(
        String(to === "inclusive" ? unit.inclusive : unit.exclusive),
      ),
    };
    const before = lineTotal(line, from, true);
    const after = lineTotal(next, to, true);
    if (before !== null && after !== null && before !== after)
      changed.push({ index, before, after });
    return next;
  });
  return { lines: converted, changed };
}
