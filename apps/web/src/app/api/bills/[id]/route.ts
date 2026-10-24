import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** One bill with its lines, payments and balance. */
export const GET = withPolicy("bill.read", billHandlers(getDatabase).read);
