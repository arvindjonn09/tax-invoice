import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { myJobHandlers } from "@/server/jobs/my-jobs";

export const dynamic = "force-dynamic";

const handlers = myJobHandlers(getDatabase);

/** Jobs assigned to the signed-in employee (no prices, costs or profit). */
export const GET = withPolicy("job.read_assigned", handlers.list);
