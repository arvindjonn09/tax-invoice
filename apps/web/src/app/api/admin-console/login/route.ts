import { adminDeps } from "@/server/admin-console";
import { adminLogin } from "@/server/admin-console/handlers";
// Owner admin console (#252): its own credentials and signed session; 404 when off.
export const POST = adminLogin(adminDeps);
