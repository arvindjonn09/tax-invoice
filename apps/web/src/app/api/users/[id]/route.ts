import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { userHandlers } from "@/server/users/handlers";
export const PATCH = withPolicy(
  "user.manage",
  userHandlers(getDatabase).update,
);
