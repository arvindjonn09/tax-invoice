import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { myJobHandlers } from "@/server/jobs/my-jobs";

export const dynamic = "force-dynamic";

const handlers = myJobHandlers(getDatabase);

/** One of my assigned jobs; any other id is a 404. */
export const GET = withPolicy("job.read_assigned", handlers.read);
