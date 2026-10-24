// Job status machine (#31). Pure: the API, the UI and tests share it.

export const JOB_STATUSES = [
  "draft",
  "quoted",
  "approved",
  "assigned",
  "in_progress",
  "awaiting_review",
  "completed",
  "invoiced",
  "closed",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Allowed moves. Backward moves exist only where work really goes back
 * (quote revised, assignment removed, rework after review). A job can be
 * cancelled at any point before it is closed (plan.md); cancelling never
 * removes its real costs. Closed and cancelled are final.
 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ["quoted", "approved", "cancelled"],
  quoted: ["draft", "approved", "cancelled"],
  approved: ["assigned", "in_progress", "cancelled"],
  assigned: ["approved", "in_progress", "cancelled"],
  in_progress: ["awaiting_review", "cancelled"],
  awaiting_review: ["in_progress", "completed", "cancelled"],
  completed: ["invoiced", "closed", "cancelled"],
  invoiced: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

/** Set only by the system (issuing an invoice, M3), never by hand. */
export const SYSTEM_ONLY_STATUSES: readonly JobStatus[] = ["invoiced"];

/**
 * Moves only the system may make: cancelling an invoiced job must come with
 * the invoice's credit note or void (M3), never as a bare status change.
 */
const SYSTEM_ONLY_MOVES: readonly (readonly [JobStatus, JobStatus])[] = [
  ["invoiced", "cancelled"],
];

/**
 * Moves only a completion review may make (#42): approving needs evidence
 * and rework needs a note, so neither is a bare status change.
 */
const REVIEW_ONLY_MOVES: readonly (readonly [JobStatus, JobStatus])[] = [
  ["awaiting_review", "completed"],
  ["awaiting_review", "in_progress"],
];

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function nextStatuses(from: JobStatus): readonly JobStatus[] {
  return TRANSITIONS[from];
}

export type TransitionProblem =
  "same-status" | "not-allowed" | "system-only" | "review-only";

/** Why `from → to` is refused for a person, or null if allowed. */
export function transitionProblem(
  from: JobStatus,
  to: JobStatus,
  {
    bySystem = false,
    byReview = false,
  }: { bySystem?: boolean; byReview?: boolean } = {},
): TransitionProblem | null {
  if (from === to) return "same-status";
  if (!TRANSITIONS[from].includes(to)) return "not-allowed";
  if (
    !bySystem &&
    (SYSTEM_ONLY_STATUSES.includes(to) ||
      SYSTEM_ONLY_MOVES.some(([a, b]) => a === from && b === to))
  )
    return "system-only";
  if (!byReview && REVIEW_ONLY_MOVES.some(([a, b]) => a === from && b === to))
    return "review-only";
  return null;
}

/** Details may still change (title, site, price, visits). */
export function isJobEditable(status: JobStatus): boolean {
  return !["invoiced", "closed", "cancelled"].includes(status);
}

/** "JOB-" + 7 → "JOB-0007" (at least four digits, never truncated). */
export function formatJobReference(prefix: string, number: number): string {
  return `${prefix}${String(number).padStart(4, "0")}`;
}
