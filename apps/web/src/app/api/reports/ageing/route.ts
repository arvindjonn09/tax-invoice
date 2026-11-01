import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { ledgerHandlers } from "@/server/reports/ledger";
export const dynamic = "force-dynamic";
export const GET = withPolicy(
  "ledger_report.read",
  ledgerHandlers(getDatabase).ageing,
);
