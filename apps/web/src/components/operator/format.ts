import type { TrialPhase } from "@jobflow/domain";

const day = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const instant = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Australia/Sydney",
});

/** `YYYY-MM-DD` as "1 Dec 2026". */
export const formatDay = (value: string | null) =>
  value ? day.format(new Date(`${value}T00:00:00Z`)) : "—";

/** An instant in Sydney time, "3 Dec 2026, 9:14 am". */
export const formatInstant = (iso: string | null) =>
  iso
    ? instant
        .format(new Date(iso))
        .replace(/\s?([AP]M)$/i, (_, m: string) => ` ${m.toLowerCase()}`)
    : "—";

export const PHASE_LABEL: Record<TrialPhase, string> = {
  normal: "Trial",
  warning: "Ending soon",
  critical: "Last day",
  expired: "Read-only",
};

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  closed: "Closed",
};

/** The outcome for the operator: extension, reason or close. */
export function operatorOutcome(row: {
  status: string;
  newLastDay: string | null;
  decisionNote: string | null;
  closedReason: string | null;
}) {
  switch (row.status) {
    case "approved":
      return `Extended to ${formatDay(row.newLastDay)}`;
    case "declined":
      return `Declined: ${row.decisionNote ?? ""}`;
    case "closed":
      return row.closedReason === "made_unrestricted"
        ? "Closed: made unrestricted"
        : "Closed: extended directly";
    default:
      return "Pending";
  }
}
