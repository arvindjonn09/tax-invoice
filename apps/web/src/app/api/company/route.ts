import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { companyHandlers } from "@/server/company/handlers";

export const dynamic = "force-dynamic";

const handlers = companyHandlers(getDatabase);

/** The active company of the signed-in member. */
export const GET = withPolicy("company.read", handlers.read);
/** Rename the active company (owners only; audited). */
export const PATCH = withPolicy("company.update", handlers.rename);
