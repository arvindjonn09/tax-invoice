import { type Cents, divideRounded } from "./money";

/**
 * Cash-basis GST attributed to one settlement (R7): round the cumulative share
 * of the document's GST, then subtract what earlier settlements attributed.
 * Partial settlements never over-attribute, and full settlement releases the
 * exact remaining GST (cumulative attribution always ends at `documentGst`).
 * For mixed-tax documents pass only the GST of the lines this settlement is
 * allocated to (see `allocateProRata`).
 */
export function cashAttributedGst(input: {
  documentTotal: Cents;
  documentGst: Cents;
  previouslySettled: Cents;
  settlement: Cents;
}): Cents {
  const { documentTotal, documentGst, previouslySettled, settlement } = input;
  if (previouslySettled < 0n || settlement < 0n) {
    throw new RangeError("Settlements must be >= 0");
  }
  if (previouslySettled + settlement > documentTotal) {
    throw new RangeError("Settlements exceed the document total");
  }
  const cumulative = (settled: Cents) =>
    cumulativeCashGst({ documentTotal, documentGst, settled });
  return (
    cumulative(previouslySettled + settlement) - cumulative(previouslySettled)
  );
}

/**
 * Cash-basis GST attributable once `settled` of the document has been paid:
 * the rounded share of its GST. Ledgers whose earlier settlements may be
 * voided reconcile each new settlement against this (see `allocationGst`).
 */
export function cumulativeCashGst(input: {
  documentTotal: Cents;
  documentGst: Cents;
  settled: Cents;
}): Cents {
  const { documentTotal, documentGst, settled } = input;
  if (documentTotal <= 0n) {
    throw new RangeError("Document total must be positive");
  }
  if (documentGst < 0n || documentGst > documentTotal) {
    throw new RangeError("Document GST must be between 0 and the total");
  }
  if (settled < 0n || settled > documentTotal) {
    throw new RangeError("Settled must be between 0 and the document total");
  }
  return divideRounded(settled * documentGst, documentTotal);
}

/**
 * Cash-basis GST correction to record when a settlement is voided: brings the
 * live attributed GST left after removing the voided settlement's share back
 * to the rounded share of what stays settled. With it, live GST always equals
 * `cumulativeCashGst` of the live settled amount, after every step.
 */
export function voidGstAdjustment(input: {
  documentTotal: Cents;
  documentGst: Cents;
  settledAfter: Cents;
  attributedAfter: Cents;
}): Cents {
  return (
    cumulativeCashGst({
      documentTotal: input.documentTotal,
      documentGst: input.documentGst,
      settled: input.settledAfter,
    }) - input.attributedAfter
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Non-cash (accruals) basis (R8): the whole GST is attributed to the period of
 * the earlier of invoice issue or the first consideration — not the due date.
 * Dates are Australia/Sydney calendar dates in `YYYY-MM-DD` form.
 */
export function nonCashAttributionDate(input: {
  invoiceIssuedOn: string;
  firstConsiderationOn?: string;
}): string {
  const dates = [input.invoiceIssuedOn, input.firstConsiderationOn].filter(
    (date): date is string => date !== undefined,
  );
  for (const date of dates) {
    if (!ISO_DATE.test(date)) throw new RangeError(`Invalid date "${date}"`);
  }
  return dates.reduce((earliest, date) => (date < earliest ? date : earliest));
}

/** Cash share after credit notes: unpaid consideration uses the remaining
 * supply; overpaid consideration retains the credited component until refunded.
 * This keeps a credit note from reporting a cash refund that has not happened.
 */
export function adjustedCashShare(input: {
  total: Cents;
  eligible: Cents;
  credited: Cents;
  creditedEligible: Cents;
  received: Cents;
}): Cents {
  const { total, eligible, credited, creditedEligible, received } = input;
  if (
    total <= 0n ||
    credited < 0n ||
    credited > total ||
    eligible < 0n ||
    eligible > total ||
    creditedEligible < 0n ||
    creditedEligible > eligible ||
    creditedEligible > credited ||
    eligible - creditedEligible > total - credited ||
    received < 0n ||
    received > total
  )
    throw new RangeError("Invalid credited cash share");
  const remaining = total - credited;
  const retained = received < remaining ? received : remaining;
  const overpaid = received - retained;
  return (
    (remaining === 0n
      ? 0n
      : divideRounded(retained * (eligible - creditedEligible), remaining)) +
    (credited === 0n
      ? 0n
      : divideRounded(overpaid * creditedEligible, credited))
  );
}
