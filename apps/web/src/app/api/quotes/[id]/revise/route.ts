import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { quoteHandlers } from "@/server/quotes/handlers";

export const dynamic = "force-dynamic";

/** Copy a sent or declined quote into a new draft revision. */
export const POST = withPolicy(
  "quote.write",
  quoteHandlers(getDatabase).revise,
);
