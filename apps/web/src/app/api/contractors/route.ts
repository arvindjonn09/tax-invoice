import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { contractorHandlers } from "@/server/contractors/handlers";

export const dynamic = "force-dynamic";

const handlers = contractorHandlers(getDatabase);

/** Search contractors (?q, ?status=active|archived|all, paged). */
export const GET = withPolicy("contractor.read", handlers.list);
/** Add a contractor (owner, manager; audited). */
export const POST = withPolicy("contractor.write", handlers.create);
