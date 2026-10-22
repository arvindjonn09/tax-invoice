import {
  type Cents,
  type Fraction,
  NONE,
  WHOLE,
  multiplyByFraction,
} from "./money";

export type PurchaseInput = {
  /** GST-exclusive amount from the supplier's document. */
  exclusive: Cents;
  /** The supplier's actual GST, kept as issued; never recalculated (R3). */
  gst: Cents;
  /** Whether the buyer is registered for GST on the purchase date (R1, R6). */
  buyerRegistered: boolean;
  /** Required evidence (e.g. a valid tax invoice) is held (R5, R6). */
  hasEvidence: boolean;
  /** Creditable (business-use) share; defaults to the whole amount. */
  creditableFraction?: Fraction;
};

export type Purchase = {
  exclusive: Cents;
  gst: Cents;
  inclusive: Cents;
  /** Claimable input tax credit: an asset, never profit or cost. */
  creditableGst: Cents;
  /** GST that cannot be claimed: part of the job cost (R6, R10). */
  nonCreditableGst: Cents;
  /** Cost recognised for job profit: exclusive + non-creditable GST. */
  jobCost: Cents;
};

export function calculatePurchase(input: PurchaseInput): Purchase {
  if (input.exclusive < 0n || input.gst < 0n) {
    throw new RangeError(
      "Purchase amounts must be >= 0; record corrections as reversals",
    );
  }
  const fraction =
    input.buyerRegistered && input.hasEvidence
      ? (input.creditableFraction ?? WHOLE)
      : NONE;
  const creditableGst = multiplyByFraction(input.gst, fraction);
  const nonCreditableGst = input.gst - creditableGst;
  return {
    exclusive: input.exclusive,
    gst: input.gst,
    inclusive: input.exclusive + input.gst,
    creditableGst,
    nonCreditableGst,
    jobCost: input.exclusive + nonCreditableGst,
  };
}

/** Internal costs with no GST at all (e.g. approved labour at a snapshotted rate). */
export function internalCost(amount: Cents): Purchase {
  if (amount < 0n) throw new RangeError("Internal cost must be >= 0");
  return {
    exclusive: amount,
    gst: 0n,
    inclusive: amount,
    creditableGst: 0n,
    nonCreditableGst: 0n,
    jobCost: amount,
  };
}
