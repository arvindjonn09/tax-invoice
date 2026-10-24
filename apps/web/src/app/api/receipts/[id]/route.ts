import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { receiptHandlers } from "@/server/receipts/handlers";

export const dynamic = "force-dynamic";

const handlers = receiptHandlers(getDatabase);

/** One receipt or refund with its allocations. */
export const GET = withPolicy("payment.read", handlers.read);
