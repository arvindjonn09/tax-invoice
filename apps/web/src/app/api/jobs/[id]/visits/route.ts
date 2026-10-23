import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { jobHandlers } from "@/server/jobs/handlers";

export const dynamic = "force-dynamic";

const handlers = jobHandlers(getDatabase);

/** Schedule a visit (audited). */
export const POST = withPolicy("job.write", handlers.addVisit);
