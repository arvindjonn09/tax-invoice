import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billSubmissionHandlers } from "@/server/bills/submissions";

export const dynamic = "force-dynamic";

const handlers = billSubmissionHandlers(getDatabase);

/** Approve: records the supplier bill once (#46 snapshot). */
export const POST = withPolicy("bill.write", handlers.approve);
