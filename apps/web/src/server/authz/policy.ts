import {
  type Actor,
  AuthzError,
  type Permission,
  forbidden,
  requirePermission,
  unauthenticated,
} from "@jobflow/authz";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import type { Auth } from "../auth/config";
import { resolveActor } from "../auth/actor";

export type PolicyDependencies = {
  auth: () => Auth;
  db: () => PrismaClient;
};

/** Resolve the request's actor and require `permission`, or throw AuthzError. */
export async function authorize(
  deps: PolicyDependencies,
  headers: Headers,
  permission: Permission,
): Promise<Actor> {
  const resolution = await resolveActor(deps.auth(), deps.db(), headers);
  if (resolution.status === "signed-out") throw unauthenticated();
  // Signed in but no active company: nothing in any company is reachable.
  if (resolution.status !== "active") throw forbidden();
  const { userId, companyId, role } = resolution.actor;
  return requirePermission({ userId, companyId, role }, permission);
}

const PRIVATE = { "cache-control": "private, no-store" };

/** JSON response that is never cached by shared caches (threat model T03). */
export function privateJson(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: { ...PRIVATE, ...init.headers },
  });
}

export type PolicyHandler<Context> = (input: {
  actor: Actor;
  request: Request;
  context: Context;
}) => Promise<Response>;

/**
 * The ONLY way to export a route handler (enforced by
 * tests/unit/route-policy.test.ts): every request is authenticated, scoped to
 * the actor's active company and checked against an explicit permission
 * before the handler runs. 401/403/404 never reveal other tenants' data.
 */
export function createWithPolicy(deps: PolicyDependencies) {
  return function withPolicy<Context = unknown>(
    permission: Permission,
    handler: PolicyHandler<Context>,
  ) {
    return async (request: Request, context: Context): Promise<Response> => {
      try {
        const actor = await authorize(deps, request.headers, permission);
        return await handler({ actor, request, context });
      } catch (error) {
        if (error instanceof AuthzError) {
          return privateJson(
            { error: error.message },
            { status: error.status },
          );
        }
        throw error;
      }
    };
  };
}
