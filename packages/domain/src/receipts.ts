import { cashAttributedGst } from "./attribution";
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
  /** Net received so far (receipts minus refunds). */
  received: Cents;
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
 * negative for a refund), cumulative so the invoice's GST is attributed
 * exactly once in total.
 */
export function allocationGst(
  kind: "receipt" | "refund",
  amount: Cents,
  balance: InvoiceBalance,
): Cents {
  if (kind === "receipt")
    return cashAttributedGst({
      documentTotal: balance.inclusive,
      documentGst: balance.gst,
      previouslySettled: balance.received,
      settlement: amount,
    });
  return -cashAttributedGst({
    documentTotal: balance.inclusive,
    documentGst: balance.gst,
    previouslySettled: balance.received - amount,
    settlement: amount,
  });
}
