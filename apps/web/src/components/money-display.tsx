import { cn } from "@/lib/utils";
/**
 * What an amount includes (#305). "no GST": a total that charged none.
 * "total": a company-wide sum that may or may not include GST (for a company
 * that has never been registered, so "incl GST" would be untrue).
 */
export type MoneyBasis = "ex GST" | "incl GST" | "no GST" | "total";

/** A document's total: "incl GST" only when it charged some (#305). */
export function totalBasis(gstCents: string | bigint | null): MoneyBasis {
  return gstCents !== null && BigInt(gstCents) !== 0n ? "incl GST" : "no GST";
}

/**
 * Company-wide totals (#305): unchanged for a company that has ever been
 * registered; otherwise sales and receipts carry no GST, and anything mixing
 * in supplier amounts is just a total.
 */
export function companyBasis(
  everRegistered: boolean,
  side: "sales" | "mixed",
): MoneyBasis {
  if (everRegistered) return "incl GST";
  return side === "sales" ? "no GST" : "total";
}
type MoneyDisplayProps = { basis: MoneyBasis; className?: string } & (
  | { cents: number | bigint; unavailable?: false }
  | { unavailable: true; cents?: never }
);
/** Formats authoritative domain cents only; never computes tax or profit. */
export function formatAudCents(cents: number | bigint): string {
  if (typeof cents === "number" && !Number.isSafeInteger(cents))
    throw new RangeError("Money requires safe integer cents or BigInt");
  const value = BigInt(cents);
  const absolute = value < 0n ? -value : value;
  const whole = new Intl.NumberFormat("en-AU", {
    maximumFractionDigits: 0,
  }).format(absolute / 100n);
  return `${value < 0n ? "−" : ""}$${whole}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
export function MoneyDisplay(props: MoneyDisplayProps) {
  return (
    <span className={cn("money", props.className)}>
      <span>
        {props.unavailable
          ? "Unavailable"
          : `${formatAudCents(props.cents)} AUD`}
      </span>
      <span> {props.basis}</span>
    </span>
  );
}
