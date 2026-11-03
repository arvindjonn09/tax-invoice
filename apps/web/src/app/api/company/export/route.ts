import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { companyExportHandler } from "@/server/company/export";

export const dynamic = "force-dynamic";

/** The whole company's records as one JSON file (owner, accountant). */
export const GET = withPolicy("export.run", companyExportHandler(getDatabase));
