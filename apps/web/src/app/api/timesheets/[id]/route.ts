import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { timesheetHandlers } from "@/server/timesheets/handlers";

export const dynamic = "force-dynamic";

const handlers = timesheetHandlers(getDatabase);

/** The submitter edits their own timesheet until it is decided (audited). */
export const PATCH = withPolicy("timesheet.submit_own", handlers.update);
