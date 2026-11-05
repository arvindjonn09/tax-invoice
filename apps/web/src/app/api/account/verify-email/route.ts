import { accountDeps } from "@/server/account";
import { verifyEmail } from "@/server/account/handlers";
// Public account endpoint (ADR 0004 D1), listed in route-policy.test.ts.
export const POST = verifyEmail(accountDeps);
