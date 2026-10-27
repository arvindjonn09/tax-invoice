import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { exportHandlers } from "@/server/exports/handlers";
export const dynamic = "force-dynamic";
export const GET = withPolicy("export.run", exportHandlers(getDatabase).run);
