import { isIsoDate } from "./registration";
import { type Cents, divideRounded } from "./money";

// Employee labour cost (#38). No payroll: an internal cost rate per hour,
// effective-dated, snapshotted onto each approved timesheet so a later rate
// change never alters past cost. Labour carries no GST.

export type RateEntry = {
  /** First day the rate applies, "YYYY-MM-DD" (inclusive). */
  effectiveFrom: string;
  /** Internal cost per hour, integer cents. */
  hourlyCost: Cents;
};

/** The rate in effect on `date`: the latest one starting on or before it. */
export function rateOn<T extends RateEntry>(
  history: readonly T[],
  date: string,
): T | null {
  if (!isIsoDate(date)) throw new RangeError(`Invalid date: ${date}`);
  let current: T | null = null;
  for (const entry of history) {
    if (
      entry.effectiveFrom <= date &&
      (current === null || entry.effectiveFrom > current.effectiveFrom)
    )
      current = entry;
  }
  return current;
}

/** Most minutes one timesheet can hold (a whole day). */
export const MAX_TIMESHEET_MINUTES = 24 * 60;

/** Minutes × hourly cost / 60, rounded to the cent once (half away from zero). */
export function labourCost(minutes: number, hourlyCost: Cents): Cents {
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_TIMESHEET_MINUTES
  )
    throw new RangeError("Minutes must be a whole number from 1 to 1440");
  if (hourlyCost < 0n) throw new RangeError("Cost rate must be >= 0");
  return divideRounded(BigInt(minutes) * hourlyCost, 60n);
}
