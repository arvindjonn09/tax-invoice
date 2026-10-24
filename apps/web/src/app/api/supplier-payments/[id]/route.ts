import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { supplierPaymentHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** One supplier payment with its allocations. */
export const GET = withPolicy(
  "payment.read",
  supplierPaymentHandlers(getDatabase).read,
);
