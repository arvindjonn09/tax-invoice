import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { assignmentHandlers } from "@/server/jobs/assignments";

export const dynamic = "force-dynamic";

const handlers = assignmentHandlers(getDatabase);

/** Assign an active employee to the job or one of its visits (owner, manager; audited). */
export const POST = withPolicy("job.assign", handlers.assign);
