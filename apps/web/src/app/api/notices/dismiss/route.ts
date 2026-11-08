import { getAuth, getDatabase, getTrustedOrigins } from "@/server/auth";
import { dismissNotice } from "@/server/trial/notices";

// Session-only endpoint, listed in route-policy.test.ts.
export const POST = dismissNotice({
  db: getDatabase,
  auth: getAuth,
  trustedOrigins: getTrustedOrigins,
});
