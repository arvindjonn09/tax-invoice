import { type GstLine, type TaxCode, calculateSupplyLine } from "./gst";
import { type Cents, sum } from "./money";
import { calculatePurchase } from "./purchases";

// Contractor offers and committed cost (#35, docs/DATA_MODEL.md#financial-definitions).
// A commitment is a signed-but-not-yet-incurred obligation: it is recorded once,
// on acceptance, and shrinks as bills linked to it arrive, so the same work is
// never counted both as committed and as incurred.

export type RateType = "fixed" | "hourly";

export type OfferTerms = {
  rateType: RateType;
  /** Fixed price, or price per hour, GST-exclusive. */
  rateExclusive: Cents;
  /** Hourly offers only: estimated hours in hundredths (7.5 h = 750). */
  estimatedHoursHundredths: bigint | null;
  taxCode: TaxCode;
  /** The contractor is registered for GST (an unregistered one can't charge it). */
  contractorRegistered: boolean;
};

/** "750" hundredths → "7.50" (a decimal quantity for `lineAmount`). */
export function hoursQuantity(hundredths: bigint): string {
  if (hundredths <= 0n) throw new RangeError("Hours must be greater than zero");
  const whole = hundredths / 100n;
  const rest = hundredths % 100n;
  return rest === 0n
    ? whole.toString()
    : `${whole}.${rest.toString().padStart(2, "0")}`;
}

/**
 * The offer's expected supply from the contractor: fixed = one unit at the
 * fixed price; hourly = estimated hours × rate. GST is rounded per line (R3).
 */
export function offerLine(terms: OfferTerms): GstLine {
  if (terms.rateExclusive < 0n)
    throw new RangeError("Offer amounts must be >= 0");
  let quantity = "1";
  if (terms.rateType === "hourly") {
    if (terms.estimatedHoursHundredths === null)
      throw new RangeError("Hourly offers need estimated hours");
    quantity = hoursQuantity(terms.estimatedHoursHundredths);
  } else if (terms.estimatedHoursHundredths !== null) {
    throw new RangeError("Fixed offers have no estimated hours");
  }
  return calculateSupplyLine({
    quantity,
    unitPrice: terms.rateExclusive,
    priceEntry: "exclusive",
    taxCode: terms.taxCode,
    supplierRegistered: terms.contractorRegistered,
  });
}

/**
 * Job cost committed on acceptance: GST-exclusive amount plus any GST the
 * company could not claim. It assumes the contractor's tax invoice will arrive;
 * the incurred cost of the actual bill replaces the estimate as it is billed.
 * Recoverable GST is never cost.
 */
export function committedJobCost(
  line: GstLine,
  companyRegistered: boolean,
): Cents {
  return calculatePurchase({
    exclusive: line.exclusive,
    gst: line.gst,
    buyerRegistered: companyRegistered,
    hasEvidence: true,
  }).jobCost;
}

export type Commitment = {
  committed: Cents;
  /** Job costs of bills linked to this commitment (already in incurred costs). */
  billed: readonly Cents[];
};

/** What is still committed after linked bills: never below zero. */
export function outstandingCommitment(commitment: Commitment): Cents {
  const remaining = commitment.committed - sum(commitment.billed);
  return remaining > 0n ? remaining : 0n;
}

export type JobCostExposure = {
  /** Costs actually incurred (bills, approved timesheets and expenses). */
  incurred: Cents;
  /** Commitments not yet billed. */
  committed: Cents;
  /** Expected total cost: incurred + outstanding commitments, each counted once. */
  total: Cents;
};

/**
 * Incurred cost plus whatever of each commitment has not been billed yet.
 * Profit uses `incurred` only (jobProfit); `total` is the forecast.
 */
export function jobCostExposure(input: {
  incurred: readonly Cents[];
  commitments: readonly Commitment[];
}): JobCostExposure {
  const incurred = sum(input.incurred);
  const committed = sum(input.commitments.map(outstandingCommitment));
  return { incurred, committed, total: incurred + committed };
}
