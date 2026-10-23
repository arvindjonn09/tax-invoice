import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { jobHandlers } from "@/server/jobs/handlers";

export const dynamic = "force-dynamic";

const handlers = jobHandlers(getDatabase);

/** A job with visits and its status timeline; other companies' ids are 404. */
export const GET = withPolicy("job.read_all", handlers.read);
/** Edit details while the job is open (audited). */
export const PATCH = withPolicy("job.write", handlers.update);
