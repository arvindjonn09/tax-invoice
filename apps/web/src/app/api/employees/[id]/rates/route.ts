import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { rateHandlers } from "@/server/timesheets/handlers";

export const dynamic = "force-dynamic";

const handlers = rateHandlers(getDatabase);

/** An employee's cost-rate history (owner, manager). */
export const GET = withPolicy("employee.cost_rate.read", handlers.list);
/** Add a rate from a start date; past approved costs never change (audited). */
export const POST = withPolicy("employee.write", handlers.add);
