import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { contractorHandlers } from "@/server/contractors/handlers";

export const dynamic = "force-dynamic";

const handlers = contractorHandlers(getDatabase);

/** Change an open offer's terms or withdraw it (audited); closed offers are final. */
export const PATCH = withPolicy("contractor.write", handlers.updateOffer);
