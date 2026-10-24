import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { timesheetHandlers } from "@/server/timesheets/handlers";

export const dynamic = "force-dynamic";

const handlers = timesheetHandlers(getDatabase);

/** The caller's own timesheets (no rate or cost). */
export const GET = withPolicy("timesheet.submit_own", handlers.mine);
