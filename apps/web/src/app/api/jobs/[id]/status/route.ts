import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { jobHandlers } from "@/server/jobs/handlers";

export const dynamic = "force-dynamic";

const handlers = jobHandlers(getDatabase);

/** Move the job to an allowed next status; appends to the immutable history. */
export const POST = withPolicy("job.write", handlers.changeStatus);
