import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { evidenceHandlers } from "@/server/jobs/evidence";

export const dynamic = "force-dynamic";

const handlers = evidenceHandlers(getDatabase);

/** Approve completion (→ completed) or request rework (→ in_progress). */
export const POST = withPolicy("job.write", handlers.review);
