import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { supplierPaymentHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** Void a supplier payment (audited, final); its bills become owing again. */
export const POST = withPolicy(
  "payment.write",
  supplierPaymentHandlers(getDatabase).void,
);
