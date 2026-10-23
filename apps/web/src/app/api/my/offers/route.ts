import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { contractorHandlers } from "@/server/contractors/handlers";

export const dynamic = "force-dynamic";

const handlers = contractorHandlers(getDatabase);

/** The signed-in subcontractor's own offers (no job price or company cost). */
export const GET = withPolicy("offer.read_own", handlers.myOffers);
