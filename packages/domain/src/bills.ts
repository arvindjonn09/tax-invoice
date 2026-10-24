import { cumulativeCashGst, voidGstAdjustment } from "./attribution";
import { type EvidenceDocument, hasPurchaseEvidence } from "./expenses";
import { type GstLine, type TaxCode, gstRateBasisPoints } from "./gst";
import { type Cents, sum } from "./money";
import { type Purchase, calculatePurchase } from "./purchases";

// Supplier and contractor bills (#46). A bill keeps the supplier's own figures
// (R3: never rewritten to our rounding). Its cost is incurred once, when it is
// recorded: GST-exclusive amount plus any GST the company can't claim.
// Payments settle the GST-inclusive balance and never change cost or profit.

export type BillLineInput = {
  taxCode: TaxCode;
  /** GST-exclusive amount as shown on the supplier's document. */
  exclusive: Cents;
  /** The supplier's GST for the line, as issued. */
  gst: Cents;
};

export type BillProblem = { field: string; message: string };

/**
 * Why a supplier line can't be recorded as entered, or null. Only a
 * GST-registered supplier can charge GST, and only on a taxable line. A
 * taxable line's GST must be 10% of its exclusive amount to the cent: within
 * one cent either way allows for the supplier's own rounding convention.
 */
export function billLineProblem(
  line: BillLineInput,
  supplierRegistered: boolean,
): string | null {
  if (line.exclusive < 0n || line.gst < 0n)
    return "Amounts can't be negative; record corrections by voiding the bill";
  if (line.taxCode !== "TAXABLE_10")
    return line.gst === 0n ? null : "Only a taxable line carries GST";
  if (!supplierRegistered)
    return "A supplier not registered for GST can't charge GST; use GST-free or out of scope";
  const difference = line.gst * 10n - line.exclusive;
  return difference >= -10n && difference <= 10n
    ? null
    : "GST must be 10% of the ex-GST amount (within one cent of the supplier's rounding)";
}

/** The supplier's line as a GST line with its rate snapshot. */
export function billLine(line: BillLineInput): GstLine {
  return {
    taxCode: line.taxCode,
    rateBasisPoints: gstRateBasisPoints(line.taxCode),
    exclusive: line.exclusive,
    gst: line.gst,
    inclusive: line.exclusive + line.gst,
  };
}

/**
 * Creditable GST and job cost of a bill. Only a company registered on the
 * bill date that holds verified evidence (a tax invoice above 8250 cents, R5)
 * can claim, limited to the recorded business-use share (basis points).
 */
export function billCost(
  lines: readonly GstLine[],
  input: {
    companyRegistered: boolean;
    document: EvidenceDocument;
    evidenceVerified: boolean;
    creditableBasisPoints: bigint;
  },
): Purchase & { hasEvidence: boolean } {
  if (input.creditableBasisPoints < 0n || input.creditableBasisPoints > 10_000n)
    throw new RangeError("Creditable share must be 0–100%");
  const exclusive = sum(lines.map((line) => line.exclusive));
  const gst = sum(lines.map((line) => line.gst));
  const hasEvidence = hasPurchaseEvidence({
    inclusive: exclusive + gst,
    document: input.document,
    verified: input.evidenceVerified,
  });
  return {
    ...calculatePurchase({
      exclusive,
      gst,
      buyerRegistered: input.companyRegistered,
      hasEvidence,
      creditableFraction: {
        numerator: input.creditableBasisPoints,
        denominator: 10_000n,
      },
    }),
    hasEvidence,
  };
}

export type BillBalance = {
  billId: string;
  /** GST-inclusive total of the bill. */
  inclusive: Cents;
  /** Creditable GST snapshot (what cash-basis payments attribute to 1B). */
  creditableGst: Cents;
  /** Paid so far by live (non-void) payments. */
  paid: Cents;
  /** Live attributed credit: those payments plus their voids' adjustments. */
  attributed: Cents;
};

/** What is still owed on a bill (never negative). */
export function billOutstanding(
  balance: Pick<BillBalance, "inclusive" | "paid">,
): Cents {
  const due = balance.inclusive - balance.paid;
  return due < 0n ? 0n : due;
}

export type PaymentAllocationRequest = { billId: string; amount: Cents };

/**
 * Why a payment of `amount` split as `allocations` can't be recorded, or [].
 * The split covers the whole amount exactly, each bill at most once, and no
 * bill is paid beyond what is owed on it (no overpayment).
 */
export function paymentProblems(
  amount: Cents,
  allocations: readonly PaymentAllocationRequest[],
  balances: ReadonlyMap<string, BillBalance>,
): BillProblem[] {
  const problems: BillProblem[] = [];
  if (amount <= 0n)
    problems.push({
      field: "amountCents",
      message: "Enter an amount above $0",
    });
  if (allocations.length === 0)
    problems.push({
      field: "allocations",
      message: "Allocate it to at least one bill",
    });
  const seen = new Set<string>();
  allocations.forEach((allocation, index) => {
    const field = `allocations.${index}`;
    if (seen.has(allocation.billId))
      problems.push({ field, message: "Each bill can appear only once" });
    seen.add(allocation.billId);
    if (allocation.amount <= 0n) {
      problems.push({ field, message: "Allocate more than $0" });
      return;
    }
    const balance = balances.get(allocation.billId);
    if (!balance) {
      problems.push({
        field,
        message: "Choose a recorded bill from this supplier",
      });
      return;
    }
    if (allocation.amount > billOutstanding(balance))
      problems.push({
        field,
        message: "That's more than is owing on this bill (overpayment)",
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
 * Cash-basis input tax credit attributed to one payment allocation (R7): what
 * takes the bill's live credit to the rounded share of what will then be
 * paid, so full payment attributes its creditable GST exactly once.
 * Non-creditable GST is cost and is never attributed.
 */
export function paymentCreditableGst(
  amount: Cents,
  balance: BillBalance,
): Cents {
  if (balance.inclusive === 0n) return 0n;
  return (
    cumulativeCashGst({
      documentTotal: balance.inclusive,
      documentGst: balance.creditableGst,
      settled: balance.paid + amount,
    }) - balance.attributed
  );
}

/**
 * Credit adjustment to record on this bill when voiding a payment allocation
 * of `amount` that attributed `gst` (0 when none is needed).
 */
export function paymentVoidAdjustment(
  allocation: { amount: Cents; gst: Cents },
  balance: BillBalance,
): Cents {
  return voidGstAdjustment({
    documentTotal: balance.inclusive,
    documentGst: balance.creditableGst,
    settledAfter: balance.paid - allocation.amount,
    attributedAfter: balance.attributed - allocation.gst,
  });
}

/**
 * Late evidence for a bill recorded without it (R6, #142). Recomputes the
 * bill's creditable GST as if the evidence had been verified at recording,
 * from the same snapshot (registration, business-use share). Returns the
 * credit it releases from job cost and, on the cash basis, the credit that
 * amounts already paid now attribute; or why nothing can be reclassified.
 */
export function billEvidenceReclass(
  lines: readonly GstLine[],
  input: {
    companyRegistered: boolean;
    document: EvidenceDocument;
    creditableBasisPoints: bigint;
    recordedCreditableGst: Cents;
    cash: boolean;
    paid: Cents;
    attributed: Cents;
  },
): { creditableGst: Cents; cashCatchUp: Cents } | { problem: string } {
  const cost = billCost(lines, { ...input, evidenceVerified: true });
  if (!cost.hasEvidence)
    return {
      problem:
        "That document isn't qualifying evidence for this bill: above $82.50 it must be a tax invoice",
    };
  const creditableGst = cost.creditableGst - input.recordedCreditableGst;
  if (creditableGst <= 0n)
    return {
      problem:
        "This bill has no GST the company can claim, so there is nothing to reclassify",
    };
  return {
    creditableGst,
    cashCatchUp: input.cash
      ? cumulativeCashGst({
          documentTotal: cost.inclusive,
          documentGst: cost.creditableGst,
          settled: input.paid,
        }) - input.attributed
      : 0n,
  };
}
