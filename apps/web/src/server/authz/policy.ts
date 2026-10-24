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
import {
  HttpError,
  MAX_JSON_BYTES,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { log, safeError } from "../log";

/** PostgreSQL and Prisma adapter errors must carry the actual SQLSTATE. */
export function isLockedPeriodError(error: unknown): boolean {
  const visited = new WeakSet<object>();
  const inspect = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    const row = value as Record<string, unknown>;
    const state = row.code ?? row.originalCode;
    if (
      state === "55000" &&
      [row.message, row.originalMessage].some(
        (message) =>
          typeof message === "string" &&
          message.includes("jobflow_period_locked"),
      )
    )
      return true;
    // At most five wrapper edges; cycles and unusually deep adapter chains
    // cannot overflow the stack inside the route's exception handler.
    if (depth === 5) return false;
    return [row.meta, row.cause, row.driverAdapterError].some((child) =>
      inspect(child, depth + 1),
    );
  };
  return inspect(error, 0);
}

export type PolicyDependencies = {
  auth: () => Auth;
  db: () => PrismaClient;
  /** Origins allowed to send state-changing requests (the app's own). */
  trustedOrigins: () => readonly string[];
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
        const actor = await authorize(deps, request.headers, permission);
        return await handler({ actor, request, context });
      } catch (error) {
        if (error instanceof AuthzError || error instanceof HttpError) {
          return privateJson(
            { error: error.message },
            { status: error.status },
          );
        }
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
