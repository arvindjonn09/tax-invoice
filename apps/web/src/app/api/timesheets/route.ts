import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { timesheetHandlers } from "@/server/timesheets/handlers";

export const dynamic = "force-dynamic";

const handlers = timesheetHandlers(getDatabase);

/** All company timesheets (?status, ?jobId, ?employeeId, paged). */
export const GET = withPolicy("timesheet.approve", handlers.list);
/** Log time on an assigned job or visit (audited). */
export const POST = withPolicy("timesheet.submit_own", handlers.create);
