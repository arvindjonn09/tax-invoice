import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { jobHandlers } from "@/server/jobs/handlers";

export const dynamic = "force-dynamic";

const handlers = jobHandlers(getDatabase);

/** Jobs, newest first (?status, ?customerId, ?q, paged). Price only with job.price.read. */
export const GET = withPolicy("job.read_all", handlers.list);
/** Create a draft job with the next per-company number (owner, manager; audited). */
export const POST = withPolicy("job.write", handlers.create);
