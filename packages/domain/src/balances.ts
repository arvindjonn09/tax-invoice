import { type Cents, sum } from "./money";

/**
 * Amount still owed on GST-inclusive documents: charged − credited − settled.
 * Customer due uses invoices/credit notes/receipts; supplier due uses
 * bills/credits/payments. Over-allocation is rejected, never shown as negative.
 */
export function outstanding(input: {
  charged: readonly Cents[];
  credited?: readonly Cents[];
  settled?: readonly Cents[];
}): Cents {
  const parts = [
    ...input.charged,
    ...(input.credited ?? []),
    ...(input.settled ?? []),
  ];
  if (parts.some((amount) => amount < 0n)) {
    throw new RangeError("Charged, credited and settled amounts must be >= 0");
  }
  const due =
    sum(input.charged) - sum(input.credited ?? []) - sum(input.settled ?? []);
  if (due < 0n) {
    throw new RangeError("Credits and settlements exceed the amount charged");
  }
  return due;
}
