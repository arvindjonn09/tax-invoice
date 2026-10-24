import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { evidenceHandlers } from "@/server/jobs/evidence";

export const dynamic = "force-dynamic";

const handlers = evidenceHandlers(getDatabase);

/** My evidence on a job I work on; add a photo, note or signature. */
export const GET = withPolicy("evidence.submit_assigned", handlers.mine);
export const POST = withPolicy("evidence.submit_assigned", handlers.add);
