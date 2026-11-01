import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billSubmissionHandlers } from "@/server/bills/submissions";

export const dynamic = "force-dynamic";

const handlers = billSubmissionHandlers(getDatabase);

/** Reject, saying what needs to change. */
export const POST = withPolicy("bill.write", handlers.reject);
