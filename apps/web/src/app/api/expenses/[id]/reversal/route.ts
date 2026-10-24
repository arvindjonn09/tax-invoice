import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { expenseHandlers } from "@/server/expenses/handlers";

export const dynamic = "force-dynamic";

const handlers = expenseHandlers(getDatabase);

/** Reverse an approved expense with its exact negated cents (audited). */
export const POST = withPolicy("expense.approve", handlers.reverse);
