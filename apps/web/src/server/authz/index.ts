import { headers } from "next/headers";
import type { Permission } from "@jobflow/authz";
import { getAuth, getDatabase } from "../auth";
import { authorize, createWithPolicy } from "./policy";

export { privateJson } from "./policy";

const deps = { auth: getAuth, db: getDatabase };

/** Wrap a route handler with an explicit permission (see policy.ts). */
export const withPolicy = createWithPolicy(deps);

/**
 * For server components and server actions: resolve the actor for this
 * request and require `permission` (throws AuthzError 401/403).
 */
export async function requireActor(permission: Permission) {
  return authorize(deps, await headers(), permission);
}
