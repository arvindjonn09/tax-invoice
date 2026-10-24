import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { expenseHandlers } from "@/server/expenses/handlers";

export const dynamic = "force-dynamic";

const handlers = expenseHandlers(getDatabase);

/** Approve (cost incurred once) or reject a submitted expense (audited). */
export const POST = withPolicy("expense.approve", handlers.decide);
