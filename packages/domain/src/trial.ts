import { daysBetween } from "./ageing";
import { isIsoDate } from "./registration";

// The 30-day company trial (#209, ADR 0004 D3). A trial is counted in Sydney
// calendar days, including daylight saving. Dates are `YYYY-MM-DD` Sydney
// days; instants are JavaScript `Date`s in UTC. Read-only is derived, never
// stored: these functions are the single TypeScript definition, and the
// database trigger that sets `read_only_from` must agree with `trialWindow`.

const ZONE = "Australia/Sydney";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Trial length counting the start day: last day = start day + 29. */
export const TRIAL_DAYS = 30;
/** Longest extension, in days from today (requirements S11 AC4, S14). */
export const MAX_EXTENSION_DAYS = 365;

const sydneyDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const sydneyHour = new Intl.DateTimeFormat("en-AU", {
  timeZone: ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

export type TrialPhase = "normal" | "warning" | "critical" | "expired";

export type TrialWindow = {
  /** The last Sydney day of access. */
  lastDay: string;
  /** 00:00 Sydney on the day after `lastDay`, as a UTC instant. */
  readOnlyFrom: Date;
};

export type TrialStatus = {
  /** N = lastDay − today (Sydney) + 1: 30 on the first day, 1 on the last. */
  daysRemaining: number;
  phase: TrialPhase;
};

export type DirectExtensionCheck =
  | { ok: true }
  | { ok: false; reason: "not_later" | "before_today" | "too_far" };

function assertInstant(instant: Date): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime()))
    throw new RangeError("Invalid instant");
}

function assertDay(value: string, name: string): void {
  if (!isIsoDate(value)) throw new RangeError(`Invalid ${name}: ${value}`);
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

/** `day` plus `days` calendar days (negative moves back). */
export function addDays(day: string, days: number): string {
  assertDay(day, "date");
  if (!Number.isInteger(days)) throw new RangeError("Days must be an integer");
  return new Date((dayNumber(day) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** The Sydney calendar day of an instant. */
export function sydneyDate(instant: Date): string {
  assertInstant(instant);
  return sydneyDay.format(instant);
}

/**
 * 00:00 Sydney on `day`, as a UTC instant. Sydney's clock changes happen at
 * 02:00/03:00, never at midnight, so midnight exists exactly once a day and
 * its offset is +10 (AEST) or +11 (AEDT).
 */
export function sydneyMidnight(day: string): Date {
  assertDay(day, "date");
  const standard = dayNumber(day) * DAY_MS - 10 * HOUR_MS;
  // At the AEST guess, a Sydney clock on daylight time reads 01:00.
  const hour = Number(sydneyHour.format(new Date(standard)));
  return new Date(hour === 1 ? standard - HOUR_MS : standard);
}

/** The trial a company started at `start` gets (30 Sydney days). */
export function trialWindow(start: Date): TrialWindow {
  const lastDay = addDays(sydneyDate(start), TRIAL_DAYS - 1);
  return { lastDay, readOnlyFrom: sydneyMidnight(addDays(lastDay, 1)) };
}

/** Days remaining and phase: normal N ≥ 8, warning 2–7, critical 1, expired ≤ 0. */
export function trialStatus(lastDay: string, now: Date): TrialStatus {
  assertDay(lastDay, "last day");
  const daysRemaining = daysBetween(sydneyDate(now), lastDay) + 1;
  const phase: TrialPhase =
    daysRemaining >= 8
      ? "normal"
      : daysRemaining >= 2
        ? "warning"
        : daysRemaining === 1
          ? "critical"
          : "expired";
  return { daysRemaining, phase };
}

/**
 * The new last day when an operator approves `days` (1–365): counted from
 * the later of the current last day and yesterday, so an expired trial gets
 * `days` days of access starting today.
 */
export function extensionLastDay(
  current: string,
  todaySydney: string,
  days: number,
): string {
  assertDay(current, "last day");
  const yesterday = addDays(todaySydney, -1);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTENSION_DAYS)
    throw new RangeError(`Days must be 1–${MAX_EXTENSION_DAYS}`);
  return addDays(current > yesterday ? current : yesterday, days);
}

/**
 * A direct extension to `newLastDay` must be later than the current last day,
 * no earlier than today and at most 365 days from today. Shortening a trial
 * is therefore always refused.
 */
export function validateDirectExtension(
  current: string,
  newLastDay: string,
  todaySydney: string,
): DirectExtensionCheck {
  assertDay(current, "last day");
  assertDay(newLastDay, "new last day");
  assertDay(todaySydney, "today");
  if (newLastDay <= current) return { ok: false, reason: "not_later" };
  if (newLastDay < todaySydney) return { ok: false, reason: "before_today" };
  if (daysBetween(todaySydney, newLastDay) > MAX_EXTENSION_DAYS)
    return { ok: false, reason: "too_far" };
  return { ok: true };
}
