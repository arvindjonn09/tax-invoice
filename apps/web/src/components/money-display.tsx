import { cn } from "@/lib/utils";
export type MoneyBasis = "ex GST" | "incl GST";
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
