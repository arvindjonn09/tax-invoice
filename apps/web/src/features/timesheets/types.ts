/** What the submitter entered (GET /api/my/timesheets): no rate or cost. */
export type OwnTimesheet = {
  id: string;
  jobId: string;
  visitId: string | null;
  workDate: string;
  minutes: number;
  note: string | null;
  status: "submitted" | "approved" | "rejected";
  decisionNote: string | null;
  decidedAt: string | null;
  reversesId: string | null;
  createdAt: string;
};
/** Office view; rate and cost only for employee.cost_rate.read. */
export type OfficeTimesheet = OwnTimesheet & {
  employeeId: string;
  employeeName: string;
  reversedById: string | null;
  hourlyCostCents?: string | null;
  costCents?: string | null;
};
export type JobOption = { id: string; reference: string; title: string };
export type VisitOption = {
  id: string;
  startsAt: string;
  endsAt: string | null;
  status: string;
};
export const STATUS_LABELS: Record<OwnTimesheet["status"], string> = {
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};
/** 450 → "7h 30m"; negative for reversals. */
export function duration(minutes: number) {
  const sign = minutes < 0 ? "−" : "";
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60),
    rest = total % 60;
  return `${sign}${hours ? `${hours}h` : ""}${hours && rest ? " " : ""}${rest || !hours ? `${rest}m` : ""}`;
}
