import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { quoteHandlers } from "@/server/quotes/handlers";

export const dynamic = "force-dynamic";

/** Record acceptance (once) and create or update the job. */
export const POST = withPolicy(
  "quote.write",
  quoteHandlers(getDatabase).accept,
);
