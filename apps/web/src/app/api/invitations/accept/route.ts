import { accountDeps } from "@/server/account";
import { acceptInvitation } from "@/server/users/handlers";
// Explicit public exception in route-policy.test.ts. A valid invitation token
// is mandatory; the handler enforces CSRF, body size, expiry and throttling.
export const POST = acceptInvitation(accountDeps);
