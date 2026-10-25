import { adjustedCashShare } from "./attribution";
import { type Cents, sum } from "./money";

// Customer receipts and refunds (#50). Money received is allocated to issued
// invoices; it never changes revenue, cost or profit (cash ≠ profit,
// docs/DATA_MODEL.md#financial-definitions). Refunds return received money.

export type AllocationRequest = { invoiceId: string; amount: Cents };

export type InvoiceBalance = {
  invoiceId: string;
  /** GST-inclusive total of the issued invoice. */
  inclusive: Cents;
  gst: Cents;
  /** Issued credit notes against it. */
  credited: Cents;
  creditedGst: Cents;
  /** Net received so far (receipts minus refunds). */
  received: Cents;
  /** Live cash-basis GST: unvoided allocations plus void adjustments. */
  attributed: Cents;
};

export type AllocationProblem = { field: string; message: string };

/** What can still be received on an invoice (never negative). */
export function receivable(balance: InvoiceBalance): Cents {
  const due = balance.inclusive - balance.credited - balance.received;
  return due < 0n ? 0n : due;
}

/**
 * Why a receipt (or refund) of `amount` split as `allocations` can't be
 * recorded, or [] if it can. The split must cover the whole amount exactly,
 * each invoice at most once; a receipt can't overpay an invoice and a refund
 * can't return more than was received on it.
 */
export function allocationProblems(
  kind: "receipt" | "refund",
  amount: Cents,
  allocations: readonly AllocationRequest[],
  balances: ReadonlyMap<string, InvoiceBalance>,
): AllocationProblem[] {
  const problems: AllocationProblem[] = [];
  if (amount <= 0n)
    problems.push({
      field: "amountCents",
      message: "Enter an amount above $0",
    });
  if (allocations.length === 0)
    problems.push({
      field: "allocations",
      message: "Allocate it to at least one invoice",
    });
  const seen = new Set<string>();
  allocations.forEach((allocation, index) => {
    const field = `allocations.${index}`;
    if (seen.has(allocation.invoiceId))
      problems.push({ field, message: "Each invoice can appear only once" });
    seen.add(allocation.invoiceId);
    if (allocation.amount <= 0n) {
      problems.push({ field, message: "Allocate more than $0" });
      return;
    }
    const balance = balances.get(allocation.invoiceId);
    if (!balance) {
      problems.push({
        field,
        message: "Choose an issued invoice of this customer",
      });
      return;
    }
    const limit = kind === "receipt" ? receivable(balance) : balance.received;
    if (allocation.amount > limit)
      problems.push({
        field,
        message:
          kind === "receipt"
            ? "That's more than is owing on this invoice (overpayment)"
            : "That's more than was received on this invoice",
      });
  });
  if (
    amount > 0n &&
    allocations.length > 0 &&
    sum(allocations.map((allocation) => allocation.amount)) !== amount
  )
    problems.push({
      field: "allocations",
      message: "The allocations must add up to the amount",
    });
  return problems;
}

/**
 * Cash-basis GST attributed to one allocation (positive for a receipt,
 * negative for a refund): what takes the invoice's live GST to the rounded
 * share of what will then be received, so it's attributed exactly once.
 */
export function allocationGst(
  kind: "receipt" | "refund",
  amount: Cents,
  balance: InvoiceBalance,
): Cents {
  return (
    adjustedCashShare({
      total: balance.inclusive,
      eligible: balance.gst,
      credited: balance.credited,
      creditedEligible: balance.creditedGst,
      received:
        kind === "receipt"
          ? balance.received + amount
          : balance.received - amount,
    }) - balance.attributed
  );
}

/**
 * GST adjustment to record on this invoice when voiding a receipt or refund
 * allocation of `amount` that attributed `gst` (0 when none is needed).
 */
export function voidAdjustmentGst(
  kind: "receipt" | "refund",
  allocation: { amount: Cents; gst: Cents },
  balance: InvoiceBalance,
): Cents {
  return (
    adjustedCashShare({
      total: balance.inclusive,
      eligible: balance.gst,
      credited: balance.credited,
      creditedEligible: balance.creditedGst,
      received:
        kind === "receipt"
          ? balance.received - allocation.amount
          : balance.received + allocation.amount,
    }) -
    (balance.attributed - allocation.gst)
  );
}

/**
 * Why voiding a receipt or refund of `amount` on this invoice can't happen,
 * or null if it can. Voiding a receipt removes money received, so refunds
 * must not then exceed it; voiding a refund restores money received, so it
 * must not then overpay what's due after credits (for example once a
 * replacement receipt has used that capacity).
 */
export function voidProblem(
  kind: "receipt" | "refund",
  balance: InvoiceBalance,
  amount: Cents,
): string | null {
  const received =
    kind === "receipt" ? balance.received - amount : balance.received + amount;
  if (received < 0n)
    return "Refunds already returned this money; void the refund first";
  if (received > balance.inclusive - balance.credited)
    return "Voiding this refund would overpay the invoice; void or refund the later receipt first";
  return null;
}
