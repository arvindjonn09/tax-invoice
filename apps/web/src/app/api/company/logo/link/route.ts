import { withPolicy } from "@/server/authz";
import { logoHandlers } from "@/server/company/logo";
import { documentDeps } from "@/server/documents";

export const dynamic = "force-dynamic";

/** A short-lived signed link to the active company's logo. */
export const GET = withPolicy("company.read", logoHandlers(documentDeps).link);
