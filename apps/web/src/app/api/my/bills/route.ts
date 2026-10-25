import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billSubmissionHandlers } from "@/server/bills/submissions";

export const dynamic = "force-dynamic";

const handlers = billSubmissionHandlers(getDatabase);

/** The signed-in subcontractor's own submitted bills (no job price or cost). */
export const GET = withPolicy("bill.submit_own", handlers.mine);
/** Submit your own tax invoice for one of your accepted offers. */
export const POST = withPolicy("bill.submit_own", handlers.submit);
