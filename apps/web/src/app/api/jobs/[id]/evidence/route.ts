import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { evidenceHandlers } from "@/server/jobs/evidence";

export const dynamic = "force-dynamic";

const handlers = evidenceHandlers(getDatabase);

/** All work evidence on a job (office). */
export const GET = withPolicy("job.read_all", handlers.office);
