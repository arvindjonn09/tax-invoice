import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** Record a bill's late tax invoice: GST moves from job cost to credit (#142). */
export const POST = withPolicy(
  "bill.write",
  billHandlers(getDatabase).evidence,
);
