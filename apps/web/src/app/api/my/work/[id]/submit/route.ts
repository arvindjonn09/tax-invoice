import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { evidenceHandlers } from "@/server/jobs/evidence";

export const dynamic = "force-dynamic";

const handlers = evidenceHandlers(getDatabase);

/** Submit a job I work on for review (in_progress → awaiting_review). */
export const POST = withPolicy("evidence.submit_assigned", handlers.submit);
