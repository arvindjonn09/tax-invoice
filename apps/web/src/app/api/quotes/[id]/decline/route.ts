import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { quoteHandlers } from "@/server/quotes/handlers";

export const dynamic = "force-dynamic";

/** Record that the customer declined (final). */
export const POST = withPolicy(
  "quote.write",
  quoteHandlers(getDatabase).decline,
);
