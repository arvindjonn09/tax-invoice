import { cumulativeCashGst } from "./attribution";
import type { GstLine } from "./gst";
import { type Cents, sum } from "./money";
import { type Purchase, calculatePurchase } from "./purchases";

// Supplier credit notes (adjustment notes) against bills (#140). A credit is
// its own immutable document, linked to one bill. It lowers what is owed,
// the job cost and the claimable GST of that bill — at the bill's own
// creditable share — and is never more than is still owing (no overcredit:
// money already paid comes back as a supplier refund, not a credit here).
// Its creditable GST is a decreasing adjustment to 1B on the non-cash basis;
// on the cash basis the bill's live credit is re-based on the net amounts.

/** What a bill was recorded with (its snapshot). */
export type CreditableBill = {
  exclusive: Cents;
  gst: Cents;
  inclusive: Cents;
  creditableGst: Cents;
  companyRegistered: boolean;
  hasEvidence: boolean;
  /** Business-use share in basis points (10000 = 100%). */
  creditableBasisPoints: bigint;
};

/** Sum of the bill's live (unvoided) credits. */
export type CreditedSoFar = {
  exclusive: Cents;
  gst: Cents;
  inclusive: Cents;
  creditableGst: Cents;
};

export const NOTHING_CREDITED: CreditedSoFar = {
  exclusive: 0n,
  gst: 0n,
  inclusive: 0n,
  creditableGst: 0n,
};

/**
 * Why a credit of these supplier lines can't be recorded against the bill,
 * or null. It must be more than $0, and it can't take the bill's exclusive
 * amount, GST or what's still owing (after earlier credits and live
 * payments) below zero.
 */
export function creditProblem(
  lines: readonly GstLine[],
  bill: CreditableBill,
  credited: CreditedSoFar,
  paid: Cents,
): string | null {
  const exclusive = sum(lines.map((line) => line.exclusive));
  const gst = sum(lines.map((line) => line.gst));
  const inclusive = exclusive + gst;
  if (lines.length === 0 || inclusive <= 0n)
    return "A credit must be more than $0";
  if (credited.exclusive + exclusive > bill.exclusive)
    return "That credits more than the bill's ex-GST amount";
  if (credited.gst + gst > bill.gst)
    return "That credits more GST than the bill charged";
  if (inclusive > bill.inclusive - credited.inclusive - paid)
    return "That's more than is still owing on the bill; a supplier refund of money already paid isn't a credit";
  return null;
}

/**
 * The credit's amounts at the bill's creditable share. Creditable GST is
 * worked out on the cumulative credited GST, so credits together never
 * reduce the claim by more (or less) than the bill's own rounding allows;
 * the rest of the GST is non-creditable and comes off the job cost.
 */
export function creditAmounts(
  lines: readonly GstLine[],
  bill: CreditableBill,
  credited: CreditedSoFar,
): Purchase {
  const exclusive = sum(lines.map((line) => line.exclusive));
  const gst = sum(lines.map((line) => line.gst));
  const cumulative = calculatePurchase({
    exclusive: credited.exclusive + exclusive,
    gst: credited.gst + gst,
    buyerRegistered: bill.companyRegistered,
    hasEvidence: bill.hasEvidence,
    creditableFraction: {
      numerator: bill.creditableBasisPoints,
      denominator: 10_000n,
    },
  });
  const raw = cumulative.creditableGst - credited.creditableGst;
  const creditableGst = raw < 0n ? 0n : raw > gst ? gst : raw;
  const nonCreditableGst = gst - creditableGst;
  return {
    exclusive,
    gst,
    inclusive: exclusive + gst,
    creditableGst,
    nonCreditableGst,
    jobCost: exclusive + nonCreditableGst,
  };
}

/**
 * Cash-basis correction to record when a bill's net amounts change (a credit
 * recorded or voided): brings the bill's live attributed credit to the
 * rounded share of what is paid, measured against the net bill. Zero when
 * nothing has been paid and nothing attributed.
 */
export function creditCashAdjustment(input: {
  netInclusive: Cents;
  netCreditableGst: Cents;
  paid: Cents;
  attributed: Cents;
}): Cents {
  if (input.netInclusive === 0n) return -input.attributed;
  return (
    cumulativeCashGst({
      documentTotal: input.netInclusive,
      documentGst: input.netCreditableGst,
      settled: input.paid,
    }) - input.attributed
  );
}
