import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { quoteHandlers } from "@/server/quotes/handlers";

export const dynamic = "force-dynamic";

const handlers = quoteHandlers(getDatabase);

/** One quote with its lines and internal estimate. */
export const GET = withPolicy("quote.read", handlers.read);
/** Edit a draft. */
export const PATCH = withPolicy("quote.write", handlers.update);
/** Discard a draft. */
export const DELETE = withPolicy("quote.write", handlers.discard);
