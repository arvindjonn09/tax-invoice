import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { assignmentHandlers } from "@/server/jobs/assignments";

export const dynamic = "force-dynamic";

const handlers = assignmentHandlers(getDatabase);

/** End an assignment with `{ "ended": true }`; history is kept (audited). */
export const PATCH = withPolicy("job.assign", handlers.end);
