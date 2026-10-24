import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { expenseHandlers } from "@/server/expenses/handlers";

export const dynamic = "force-dynamic";

const handlers = expenseHandlers(getDatabase);

/** All company expenses (?status, ?jobId=<id>|none, paged). */
export const GET = withPolicy("expense.read_all", handlers.list);
/** Submit an expense (employees: assigned jobs only; audited). */
export const POST = withPolicy("expense.submit_own", handlers.create);
