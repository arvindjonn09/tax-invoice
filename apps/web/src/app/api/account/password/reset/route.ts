import { accountDeps } from "@/server/account";
import { resetPassword } from "@/server/account/handlers";
// Public account endpoint (ADR 0004 D1), listed in route-policy.test.ts.
export const POST = resetPassword(accountDeps);
