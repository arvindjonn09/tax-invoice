import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billSubmissionHandlers } from "@/server/bills/submissions";

export const dynamic = "force-dynamic";

const handlers = billSubmissionHandlers(getDatabase);

export const GET = withPolicy("bill.read", handlers.read);
