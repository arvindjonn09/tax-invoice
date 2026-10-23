import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { contractorHandlers } from "@/server/contractors/handlers";

export const dynamic = "force-dynamic";

const handlers = contractorHandlers(getDatabase);

/** Offers on this job, with acceptance snapshots and committed cost. */
export const GET = withPolicy("contractor.read", handlers.jobOffers);
/** Offer work to a contractor (audited). */
export const POST = withPolicy("contractor.write", handlers.createOffer);
