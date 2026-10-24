import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { reportHandlers } from "@/server/reports/handlers";
export const dynamic = "force-dynamic";
export const GET = withPolicy(
  "gst_report.read",
  reportHandlers(getDatabase).gst,
);
