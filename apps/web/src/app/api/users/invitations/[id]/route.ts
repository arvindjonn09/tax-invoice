import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { userHandlers } from "@/server/users/handlers";
export const DELETE = withPolicy(
  "user.manage",
  userHandlers(getDatabase).revoke,
);
