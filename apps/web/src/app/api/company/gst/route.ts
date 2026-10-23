import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { gstHandlers } from "@/server/company/gst";

export const dynamic = "force-dynamic";

const handlers = gstHandlers(getDatabase);

/** BAS period, GST registration periods and today's status. */
export const GET = withPolicy("gst_settings.read", handlers.read);
/** Change the BAS reporting period (owner, accountant; audited). */
export const PATCH = withPolicy("gst_settings.update", handlers.setBasPeriod);
