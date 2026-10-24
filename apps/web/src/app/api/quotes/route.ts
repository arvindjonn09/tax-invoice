import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { quoteHandlers } from "@/server/quotes/handlers";

export const dynamic = "force-dynamic";

const handlers = quoteHandlers(getDatabase);

/** Quotes and variations (?status, ?customerId, ?jobId; paged). */
export const GET = withPolicy("quote.read", handlers.list);
/** Draft a quote or a variation of a job. */
export const POST = withPolicy("quote.write", handlers.create);
