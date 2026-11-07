import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { setupChecklistHandlers } from "@/server/company/setup-checklist";

export const dynamic = "force-dynamic";

const handlers = setupChecklistHandlers(getDatabase);

/** Hide "Finish setting up your company" for good (owners; audited, S5 AC8). */
export const POST = withPolicy("company.update", handlers.dismiss);
