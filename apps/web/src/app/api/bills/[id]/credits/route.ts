import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { supplierCreditHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** Record a supplier credit note (adjustment note) against this bill. */
export const POST = withPolicy(
  "bill.write",
  supplierCreditHandlers(getDatabase).create,
);
