import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { gstHandlers } from "@/server/company/gst";

export const dynamic = "force-dynamic";

const handlers = gstHandlers(getDatabase);

/** End a registration period or correct its basis (audited). */
export const PATCH = withPolicy(
  "gst_settings.update",
  handlers.changeRegistration,
);
