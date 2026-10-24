import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { periodHandlers } from "@/server/reports/periods";
export const dynamic = "force-dynamic";
export const POST = withPolicy(
  "gst_settings.update",
  periodHandlers(getDatabase).adjust,
);
