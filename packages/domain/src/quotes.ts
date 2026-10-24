import { type GstLine, documentTotals } from "./gst";
import { type Cents, sum } from "./money";
import { jobProfit } from "./profit";

// Quotes and variations (#44). A quote's prices and tax are frozen when it is
// sent; acceptance is recorded once and never changes. Estimated revenue and
// profit are always GST-exclusive: GST collected is never revenue.

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "superseded",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
/** What the office sees: a sent quote past its validity date has expired. */
export type QuoteState = QuoteStatus | "expired";

/** Dates are Australia/Sydney calendar days, `YYYY-MM-DD`. */
export function quoteState(
  status: QuoteStatus,
  validUntil: string | null,
  today: string,
): QuoteState {
  return status === "sent" && validUntil !== null && validUntil < today
    ? "expired"
    : status;
}

export type QuoteEstimate = {
  /** Quoted revenue, GST-exclusive (the job's estimated revenue). */
  exclusive: Cents;
  gst: Cents;
  inclusive: Cents;
  /** Internal estimated cost of the quoted work (never shown to customers). */
  estimatedCost: Cents;
  /** exclusive − estimated cost; GST never enters it. */
  estimatedProfit: Cents;
  /** Profit / revenue in basis points; null for zero revenue. */
  marginBasisPoints: Cents | null;
};

/** Totals of the priced lines plus the internal estimate, all ex GST. */
export function quoteEstimate(
  lines: readonly GstLine[],
  estimatedCosts: readonly Cents[],
): QuoteEstimate {
  if (estimatedCosts.some((cost) => cost < 0n))
    throw new RangeError("Estimated costs must be >= 0");
  const totals = documentTotals(lines);
  const profit = jobProfit({
    revenueExclusive: [totals.exclusive],
    jobCosts: estimatedCosts,
  });
  return {
    exclusive: totals.exclusive,
    gst: totals.gst,
    inclusive: totals.inclusive,
    estimatedCost: sum(estimatedCosts),
    estimatedProfit: profit.profit,
    marginBasisPoints: profit.marginBasisPoints,
  };
}

export type AcceptCheck = {
  status: QuoteStatus;
  validUntil: string | null;
  today: string;
  kind: "quote" | "variation";
  /** Status of the job the quote is linked to, if any. */
  jobStatus: string | null;
};

/** Why a quote can't be accepted now, or null. */
export function acceptProblem(input: AcceptCheck): string | null {
  if (input.status !== "sent")
    return input.status === "draft"
      ? "Send the quote before recording acceptance"
      : `A ${input.status} quote can't be accepted`;
  if (input.validUntil !== null && input.validUntil < input.today)
    return "This quote has expired; revise it with a new validity date";
  if (input.kind === "variation") {
    if (input.jobStatus === null) return "A variation needs its job";
    if (["draft", "quoted", "closed", "cancelled"].includes(input.jobStatus))
      return "Variations apply to approved, open jobs";
  } else if (
    input.jobStatus !== null &&
    !["draft", "quoted"].includes(input.jobStatus)
  )
    return "That job has already been approved; quote a variation instead";
  return null;
}

/**
 * The job's estimated revenue after an accepted quote or variation: a quote
 * sets it, a variation adds to it (both GST-exclusive).
 */
export function revenueAfterAcceptance(
  current: Cents | null,
  kind: "quote" | "variation",
  exclusive: Cents,
): Cents {
  if (exclusive < 0n) throw new RangeError("Quoted amounts must be >= 0");
  return kind === "quote" ? exclusive : (current ?? 0n) + exclusive;
}
