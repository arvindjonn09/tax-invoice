import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { contractorHandlers } from "@/server/contractors/handlers";

export const dynamic = "force-dynamic";

const handlers = contractorHandlers(getDatabase);

/** Accept or decline one of your own open offers (audited). */
export const POST = withPolicy("offer.respond_own", handlers.respond);
