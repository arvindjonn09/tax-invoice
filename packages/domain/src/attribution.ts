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
  if (documentTotal <= 0n) {
    throw new RangeError("Document total must be positive");
  }
  if (documentGst < 0n || documentGst > documentTotal) {
    throw new RangeError("Document GST must be between 0 and the total");
  }
  if (previouslySettled < 0n || settlement < 0n) {
    throw new RangeError("Settlements must be >= 0");
  }
  if (previouslySettled + settlement > documentTotal) {
    throw new RangeError("Settlements exceed the document total");
  }
  const cumulative = (settled: Cents) =>
    divideRounded(settled * documentGst, documentTotal);
  return (
    cumulative(previouslySettled + settlement) - cumulative(previouslySettled)
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
