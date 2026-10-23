import { type Permission, type Role, can } from "./policy";

/** The resolved, server-trusted identity for one request. */
export type Actor = {
  userId: string;
  companyId: string;
  role: Role;
};

/** 401 signed out, 403 not permitted, 404 missing or another company's record. */
export class AuthzError extends Error {
  constructor(
    readonly status: 401 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "AuthzError";
  }
}

export const unauthenticated = () => new AuthzError(401, "Sign in to continue");
export const forbidden = () =>
  new AuthzError(403, "You don't have permission to do that");
export const notFound = () => new AuthzError(404, "Not found");

/** Throws 401 without an actor and 403 unless the role holds the permission. */
export function requirePermission(
  actor: Actor | null | undefined,
  permission: Permission,
): Actor {
  if (!actor) throw unauthenticated();
  if (!can(actor.role, permission)) throw forbidden();
  return actor;
}

/**
 * Company scope for every query: the actor's company always wins over any
 * `companyId` in client input, so a forged id can never widen access.
 */
export function companyScope<T extends object>(
  actor: Actor,
  where?: T,
): Omit<T, "companyId"> & { companyId: string } {
  const scoped: Record<string, unknown> = { ...(where ?? {}) };
  delete scoped.companyId;
  return {
    ...(scoped as Omit<T, "companyId">),
    companyId: actor.companyId,
  };
}

/**
 * Object check after a lookup: another company's record is reported as
 * "not found" (never 403), so ids from other tenants can't be probed.
 */
export function requireSameCompany<T extends { companyId: string }>(
  actor: Actor,
  record: T | null | undefined,
): T {
  if (!record || record.companyId !== actor.companyId) throw notFound();
  return record;
}

/** The actor's own company row (companies are the tenant, so they have no companyId). */
export function requireOwnCompany<T extends { id: string }>(
  actor: Actor,
  company: T | null | undefined,
): T {
  if (!company || company.id !== actor.companyId) throw notFound();
  return company;
}
