import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { timesheetHandlers } from "@/server/timesheets/handlers";

export const dynamic = "force-dynamic";

const handlers = timesheetHandlers(getDatabase);

/** Approve (cost snapshotted once) or reject (audited). */
export const POST = withPolicy("timesheet.approve", handlers.decide);
