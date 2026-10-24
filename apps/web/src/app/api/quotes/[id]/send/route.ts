import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { quoteHandlers } from "@/server/quotes/handlers";

export const dynamic = "force-dynamic";

/** Send: freeze prices and tax on the send date. */
export const POST = withPolicy("quote.write", quoteHandlers(getDatabase).send);
