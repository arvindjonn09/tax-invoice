import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { trialHandlers } from "@/server/trial/handlers";

export const dynamic = "force-dynamic";

const handlers = trialHandlers(getDatabase);

/** The company's trial status: full for owner/manager/accountant, read-only flag for everyone else (#221). */
export const GET = withPolicy("company.read", handlers.status);
