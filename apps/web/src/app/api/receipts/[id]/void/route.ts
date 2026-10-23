import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { receiptHandlers } from "@/server/receipts/handlers";

export const dynamic = "force-dynamic";

const handlers = receiptHandlers(getDatabase);

/** Void a receipt or refund with a reason (audited, final). */
export const POST = withPolicy("payment.write", handlers.void);
