/** Decimal AUD input at the UI boundary, converted with integer arithmetic. */
export function parseAudInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^(?:\d{1,11}(?:\.\d{0,2})?|\.\d{1,2})$/.test(text))
    throw new RangeError(
      "Enter a non-negative AUD amount with up to two decimal places.",
    );
  const [whole = "0", fraction = ""] = text.split(".");
  const cents = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > 1_000_000_000_000n)
    throw new RangeError("Enter an amount up to $10,000,000,000.00.");
  return cents.toString();
}
export function audInput(cents: string | null | undefined): string {
  if (cents == null) return "";
  const amount = BigInt(cents);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
}

/**
 * A percentage with up to two decimals (0–100) as integer basis points, or
 * null when it isn't one. No floating point: "50.5" → 5050.
 */
export function percentToBasisPoints(input: string): number | null {
  const text = input.trim();
  if (!/^(100(\.0{1,2})?|[1-9]?\d(\.\d{1,2})?)$/.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
