import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { companyHandlers } from "@/server/company/handlers";

export const dynamic = "force-dynamic";

const handlers = companyHandlers(getDatabase);

/** The active company of the signed-in member (details for owner/accountant). */
export const GET = withPolicy("company.read", handlers.read);
/** Update the company profile: name, legal name, ABN, address, prefixes (owners; audited). */
export const PATCH = withPolicy("company.update", handlers.update);
