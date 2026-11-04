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
import { type CompanyAccess, resolveActor } from "../auth/actor";
import {
  HttpError,
  MAX_JSON_BYTES,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { hasDatabaseError } from "../http/database-errors";
import { log, safeError } from "../log";
import {
  READ_ONLY_RESPONSE,
  allowedWhileReadOnly,
  isCompanyReadOnlyError,
} from "./read-only";

/** PostgreSQL and Prisma adapter errors must carry the actual SQLSTATE. */
export function isLockedPeriodError(error: unknown): boolean {
  return hasDatabaseError(error, "55000", "jobflow_period_locked");
}

export type PolicyDependencies = {
  auth: () => Auth;
  db: () => PrismaClient;
  /** Origins allowed to send state-changing requests (the app's own). */
  trustedOrigins: () => readonly string[];
};

/**
 * Resolve the request's actor and require `permission`, or throw AuthzError.
 * Also returns the company's trial access, from the same lookup (#221).
 */
export async function authorizeRequest(
  deps: PolicyDependencies,
  headers: Headers,
  permission: Permission,
): Promise<{ actor: Actor; access: CompanyAccess }> {
  const resolution = await resolveActor(deps.auth(), deps.db(), headers);
  if (resolution.status === "signed-out") throw unauthenticated();
  // Signed in but no active company: nothing in any company is reachable.
  if (resolution.status !== "active") throw forbidden();
  const { userId, companyId, role, access } = resolution.actor;
  return {
    actor: requirePermission({ userId, companyId, role }, permission),
    access,
  };
}

/** Resolve the request's actor and require `permission`, or throw AuthzError. */
export async function authorize(
  deps: PolicyDependencies,
  headers: Headers,
  permission: Permission,
): Promise<Actor> {
  return (await authorizeRequest(deps, headers, permission)).actor;
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
  /**
   * The company's trial access for this request (#221). Always set by
   * withPolicy; optional so handlers can be called directly in tests.
   */
  access?: CompanyAccess;
  request: Request;
  context: Context;
}) => Promise<Response>;

/**
 * The ONLY way to export a route handler (enforced by
 * tests/unit/route-policy.test.ts): every request is authenticated, scoped to
 * the actor's active company and checked against an explicit permission
 * before the handler runs. 401/403/404 never reveal other tenants' data.
 * Mutations must come from the app's own origin and declare a body within
 * `maxBodyBytes`; unexpected errors are logged redacted and answered with a
 * generic 500 that carries only a reference.
 */
export function createWithPolicy(deps: PolicyDependencies) {
  return function withPolicy<Context = unknown>(
    permission: Permission,
    handler: PolicyHandler<Context>,
    { maxBodyBytes = MAX_JSON_BYTES }: { maxBodyBytes?: number } = {},
  ) {
    return async (request: Request, context: Context): Promise<Response> => {
      try {
        requireTrustedOrigin(request, deps.trustedOrigins());
        requireBodyWithin(request, maxBodyBytes);
        const { actor, access } = await authorizeRequest(
          deps,
          request.headers,
          permission,
        );
        // ADR 0004 D4: a read-only company can't change anything except
        // the READ_ONLY_ALLOWED routes. Safe methods are never blocked.
        if (
          access.readOnly &&
          !allowedWhileReadOnly(request.method, new URL(request.url).pathname)
        )
          return privateJson(READ_ONLY_RESPONSE, { status: 403 });
        return await handler({ actor, access, request, context });
      } catch (error) {
        if (error instanceof AuthzError || error instanceof HttpError) {
          return privateJson(
            { error: error.message },
            { status: error.status },
          );
        }
        // The commit-time database guard (a write that raced the expiry).
        if (isCompanyReadOnlyError(error))
          return privateJson(READ_ONLY_RESPONSE, { status: 403 });
        if (isLockedPeriodError(error))
          return privateJson(
            {
              error:
                "This financial period is locked. Record an explicit correction or amendment.",
            },
            { status: 409 },
          );
        const reference = crypto.randomUUID();
        log("error", "route.unhandled", {
          reference,
          permission,
          method: request.method,
          path: new URL(request.url).pathname,
          error: safeError(error),
        });
        return privateJson(
          { error: "Something went wrong. Try again.", reference },
          { status: 500 },
        );
      }
    };
  };
}
