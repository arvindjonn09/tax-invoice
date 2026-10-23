import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { contractorHandlers } from "@/server/contractors/handlers";

export const dynamic = "force-dynamic";

const handlers = contractorHandlers(getDatabase);

/** One contractor with their offers. */
export const GET = withPolicy("contractor.read", handlers.read);
/** Edit, link a login, archive or restore (audited). */
export const PATCH = withPolicy("contractor.write", handlers.update);
