import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { expenseHandlers } from "@/server/expenses/handlers";

export const dynamic = "force-dynamic";

const handlers = expenseHandlers(getDatabase);

/** The caller's own submitted expenses (no cost or credit split). */
export const GET = withPolicy("expense.submit_own", handlers.mine);
