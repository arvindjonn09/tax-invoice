import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { dashboardHandler } from "@/server/dashboard/handlers";
export const dynamic = "force-dynamic";
export const GET = withPolicy("job.profit.read", dashboardHandler(getDatabase));
