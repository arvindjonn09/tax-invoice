import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { supplierPaymentHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

const handlers = supplierPaymentHandlers(getDatabase);

/** Payments to suppliers and contractors (?contractorId, paged). */
export const GET = withPolicy("payment.read", handlers.list);
/** Record a payment with bill allocations. Requires an Idempotency-Key header. */
export const POST = withPolicy("payment.write", handlers.create);
