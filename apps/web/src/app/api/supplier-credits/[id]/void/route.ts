import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { supplierCreditHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** Void a supplier credit (audited, final). */
export const POST = withPolicy(
  "bill.write",
  supplierCreditHandlers(getDatabase).void,
);
