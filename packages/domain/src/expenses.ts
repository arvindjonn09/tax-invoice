import {
  type GstLine,
  type PriceEntry,
  type TaxCode,
  calculateSupplyLine,
} from "./gst";
import { type Cents, sum } from "./money";
import { type Purchase, calculatePurchase } from "./purchases";

// Job and general expenses (#40). Cost is incurred once, on approval:
// GST-exclusive amount plus any GST the company can't claim. Settlement
// (paid at purchase or on account) moves cash or creates a supplier balance
// and never changes cost (docs/DATA_MODEL.md#financial-definitions).

export const EXPENSE_CATEGORIES = [
  "materials",
  "travel",
  "parking",
  "equipment",
  "misc",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export type Settlement = "paid_at_purchase" | "on_account";

/**
 * R5: a tax invoice is generally needed to claim GST on a purchase over
 * 8250 cents including GST; exactly 8250 is within the low-value exception.
 */
export const LOW_VALUE_PURCHASE_CENTS = 8250n;

/** The receipt line as entered: one amount, GST-exclusive or -inclusive. */
export function expenseLine(input: {
  amount: Cents;
  priceEntry: PriceEntry;
  taxCode: TaxCode;
}): GstLine {
  if (input.amount < 0n)
    throw new RangeError(
      "Expense amounts must be >= 0; correct with a reversal",
    );
  // A supplier charging GST is registered by definition; zero-rated codes
  // carry no GST either way.
  return calculateSupplyLine({
    quantity: "1",
    unitPrice: input.amount,
    priceEntry: input.priceEntry,
    taxCode: input.taxCode,
    supplierRegistered: true,
  });
}

/** Evidence for an input tax credit: a receipt on file, or a low-value purchase. */
export function hasPurchaseEvidence(
  inclusive: Cents,
  receiptAttached: boolean,
): boolean {
  return receiptAttached || inclusive <= LOW_VALUE_PURCHASE_CENTS;
}

/**
 * Creditable GST and job cost of an approved expense. Only a company
 * registered on the purchase date, holding evidence, can claim; the claim is
 * limited to the business-use share (basis points, 10000 = 100%).
 */
export function expenseCost(
  line: GstLine,
  input: {
    companyRegistered: boolean;
    receiptAttached: boolean;
    creditableBasisPoints: bigint;
  },
): Purchase {
  if (input.creditableBasisPoints < 0n || input.creditableBasisPoints > 10_000n)
    throw new RangeError("Creditable share must be 0–100%");
  return calculatePurchase({
    exclusive: line.exclusive,
    gst: line.gst,
    buyerRegistered: input.companyRegistered,
    hasEvidence: hasPurchaseEvidence(line.inclusive, input.receiptAttached),
    creditableFraction: {
      numerator: input.creditableBasisPoints,
      denominator: 10_000n,
    },
  });
}

/** A reversal cancels the original's exact cents (never recalculated). */
export function reverseExpense(original: Purchase): Purchase {
  return {
    exclusive: -original.exclusive,
    gst: -original.gst,
    inclusive: -original.inclusive,
    creditableGst: -original.creditableGst,
    nonCreditableGst: -original.nonCreditableGst,
    jobCost: -original.jobCost,
  };
}

export type ApprovedExpense = {
  settlement: Settlement;
  /** Snapshot at approval; negative for a reversal. */
  inclusive: Cents;
  jobCost: Cents;
  creditableGst: Cents;
};

export type ExpenseTotals = {
  /** Incurred job cost (exclusive + non-creditable GST). */
  cost: Cents;
  /** Input tax credits (1B); an asset, never cost. */
  creditableGst: Cents;
  /** Cash paid at purchase (refunds of reversed paid expenses net off). */
  cashPaid: Cents;
  /** Owed to suppliers for on-account expenses, before supplier payments. */
  supplierOutstanding: Cents;
};

/**
 * Totals over approved expenses (and their reversals). Each expense lands in
 * exactly one of cash paid or supplier outstanding, so cash + outstanding =
 * the GST-inclusive total, whatever the mix; cost ignores settlement.
 */
export function expenseTotals(rows: readonly ApprovedExpense[]): ExpenseTotals {
  const paid = rows.filter((row) => row.settlement === "paid_at_purchase");
  const onAccount = rows.filter((row) => row.settlement === "on_account");
  return {
    cost: sum(rows.map((row) => row.jobCost)),
    creditableGst: sum(rows.map((row) => row.creditableGst)),
    cashPaid: sum(paid.map((row) => row.inclusive)),
    supplierOutstanding: sum(onAccount.map((row) => row.inclusive)),
  };
}

/** "75%" ⇄ 7500 basis points, without floating point. */
export function percentToBasisPoints(percent: string): bigint {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent);
  if (!match) throw new RangeError(`Invalid percentage "${percent}"`);
  const value =
    BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (value > 10_000n) throw new RangeError("Percentage must be 0–100");
  return value;
}
