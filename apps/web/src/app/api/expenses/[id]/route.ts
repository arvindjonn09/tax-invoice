import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { expenseHandlers } from "@/server/expenses/handlers";

export const dynamic = "force-dynamic";

const handlers = expenseHandlers(getDatabase);

/** One expense with its approval snapshot. */
export const GET = withPolicy("expense.read_all", handlers.read);
/** The submitter edits their own expense until it is decided (audited). */
export const PATCH = withPolicy("expense.submit_own", handlers.update);
