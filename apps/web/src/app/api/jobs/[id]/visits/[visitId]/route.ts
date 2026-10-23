import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { jobHandlers } from "@/server/jobs/handlers";

export const dynamic = "force-dynamic";

const handlers = jobHandlers(getDatabase);

/** Reschedule, complete or cancel a visit (audited). */
export const PATCH = withPolicy("job.write", handlers.updateVisit);
