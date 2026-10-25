import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { supplierCreditHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** One supplier credit with its lines and cash-basis GST corrections. */
export const GET = withPolicy(
  "bill.read",
  supplierCreditHandlers(getDatabase).read,
);
