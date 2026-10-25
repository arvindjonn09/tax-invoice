import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billSubmissionHandlers } from "@/server/bills/submissions";

export const dynamic = "force-dynamic";

const handlers = billSubmissionHandlers(getDatabase);

/** The office queue of subcontractor bills (?status=submitted|approved|rejected). */
export const GET = withPolicy("bill.read", handlers.list);
