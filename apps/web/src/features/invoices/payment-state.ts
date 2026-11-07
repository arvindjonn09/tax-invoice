import type { Invoice } from "./types";

export type PaymentState =
  | { label: "Unpaid"; owingCents: bigint }
  | { label: "Part paid"; owingCents: bigint }
  | { label: "Paid" }
  | { label: "Credited in full" };

/**
 * Where an issued invoice stands with its customer (#304), from the list's
 * balance fields. Null when there's nothing to say: drafts, void invoices,
 * credit notes, and roles without payment.read (no balance fields arrive).
 */
export function paymentState(
  row: Pick<
    Invoice,
    | "kind"
    | "status"
    | "inclusiveCents"
    | "receivedCents"
    | "creditedCents"
    | "outstandingCents"
  >,
): PaymentState | null {
  if (row.kind !== "invoice" || row.status !== "issued") return null;
  if (row.outstandingCents === undefined || row.receivedCents === undefined)
    return null;
  const owing = BigInt(row.outstandingCents);
  const received = BigInt(row.receivedCents);
  const credited = BigInt(row.creditedCents ?? "0");
  if (owing === 0n)
    return received === 0n && credited > 0n
      ? { label: "Credited in full" }
      : { label: "Paid" };
  return received === 0n
    ? { label: "Unpaid", owingCents: owing }
    : { label: "Part paid", owingCents: owing };
}
