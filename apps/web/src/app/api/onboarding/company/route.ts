import { getAuth, getDatabase, getTrustedOrigins } from "@/server/auth";
import { createCompany } from "@/server/onboarding/handlers";
// Session-only endpoint (no company yet), listed in route-policy.test.ts.
export const POST = createCompany({
  db: getDatabase,
  auth: getAuth,
  trustedOrigins: getTrustedOrigins,
});
