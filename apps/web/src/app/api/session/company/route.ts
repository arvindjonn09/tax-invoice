import { getAuth, getDatabase, getTrustedOrigins } from "@/server/auth";
import { selectCompany } from "@/server/onboarding/handlers";
// Session-only endpoint (no active company yet), listed in route-policy.test.ts.
export const POST = selectCompany({
  db: getDatabase,
  auth: getAuth,
  trustedOrigins: getTrustedOrigins,
});
