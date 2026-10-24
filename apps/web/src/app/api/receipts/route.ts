import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { receiptHandlers } from "@/server/receipts/handlers";

export const dynamic = "force-dynamic";

const handlers = receiptHandlers(getDatabase);

/** Receipts and refunds (?customerId, paged). */
export const GET = withPolicy("payment.read", handlers.list);
/** Record a receipt or refund with allocations. Requires an Idempotency-Key header. */
export const POST = withPolicy("payment.write", handlers.create);
