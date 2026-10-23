// Effective-dated GST registration (#25, docs/GST.md#company-configuration).
// Dates are calendar days as "YYYY-MM-DD" (Australia/Sydney business dates),
// which compare correctly as strings.

export type GstBasis = "cash" | "non_cash";

export type GstRegistrationPeriod = {
  /** First registered day, inclusive. */
  startsOn: string;
  /** Last registered day, inclusive; null = open-ended. */
  endsOn: string | null;
  basis: GstBasis;
};

export type GstStatusOnDate =
  { registered: true; basis: GstBasis } | { registered: false; basis: null };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function covers(period: GstRegistrationPeriod, date: string): boolean {
  return (
    period.startsOn <= date && (period.endsOn === null || date <= period.endsOn)
  );
}

/** Is the company registered on `date`, and on which accounting basis? */
export function gstStatusOn(
  periods: readonly GstRegistrationPeriod[],
  date: string,
): GstStatusOnDate {
  if (!isIsoDate(date)) throw new RangeError(`Invalid date: ${date}`);
  const period = periods.find((candidate) => covers(candidate, date));
  return period
    ? { registered: true, basis: period.basis }
    : { registered: false, basis: null };
}

/** Do two periods share at least one day? (Inclusive bounds.) */
export function periodsOverlap(
  a: GstRegistrationPeriod,
  b: GstRegistrationPeriod,
): boolean {
  return (
    (a.endsOn === null || b.startsOn <= a.endsOn) &&
    (b.endsOn === null || a.startsOn <= b.endsOn)
  );
}

export type PeriodProblem = "invalid-date" | "ends-before-start" | "overlap";

/**
 * Why `candidate` cannot join `existing` (other periods of the same company),
 * or null if it can. The database enforces the same rule.
 */
export function registrationProblem(
  candidate: GstRegistrationPeriod,
  existing: readonly GstRegistrationPeriod[],
): PeriodProblem | null {
  if (
    !isIsoDate(candidate.startsOn) ||
    (candidate.endsOn !== null && !isIsoDate(candidate.endsOn))
  )
    return "invalid-date";
  if (candidate.endsOn !== null && candidate.endsOn < candidate.startsOn)
    return "ends-before-start";
  return existing.some((period) => periodsOverlap(candidate, period))
    ? "overlap"
    : null;
}
