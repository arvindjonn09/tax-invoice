import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

/** Void an unpaid bill (audited, final). */
export const POST = withPolicy("bill.write", billHandlers(getDatabase).void);
