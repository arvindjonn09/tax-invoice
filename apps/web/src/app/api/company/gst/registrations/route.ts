import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { gstHandlers } from "@/server/company/gst";

export const dynamic = "force-dynamic";

const handlers = gstHandlers(getDatabase);

/** Add a GST registration period; overlaps are refused with 409. */
export const POST = withPolicy("gst_settings.update", handlers.addRegistration);
