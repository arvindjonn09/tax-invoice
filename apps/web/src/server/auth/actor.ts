import type {
  MembershipRole,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import type { Auth } from "./config";

/** Who is acting, and in which company, for one request. */
export type Actor = {
  userId: string;
  sessionId: string;
  companyId: string;
  role: MembershipRole;
};

export type ActorResolution =
  | { status: "signed-out" }
  | { status: "no-membership"; userId: string }
  | {
      status: "choose-company";
      userId: string;
      companies: { companyId: string; role: MembershipRole }[];
    }
  | { status: "active"; actor: Actor };

/**
 * Resolve the actor from the session cookie on EVERY request. Company and role
 * come from the database (active memberships), never from client input. A
 * session's remembered company is honoured only while that membership is
 * still active; a single active membership is selected automatically.
 */
export async function resolveActor(
  auth: Auth,
  db: PrismaClient,
  headers: Headers,
): Promise<ActorResolution> {
  const session = await auth.api.getSession({ headers });
  if (!session) return { status: "signed-out" };
  const userId = session.user.id;
  const memberships = await db.membership.findMany({
    where: { userId, isActive: true },
    select: { companyId: true, role: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (memberships.length === 0) return { status: "no-membership", userId };
  const remembered = session.session.activeCompanyId;
  const active =
    memberships.find((membership) => membership.companyId === remembered) ??
    (memberships.length === 1 ? memberships[0] : undefined);
  if (!active) {
    return { status: "choose-company", userId, companies: memberships };
  }
  return {
    status: "active",
    actor: {
      userId,
      sessionId: session.session.id,
      companyId: active.companyId,
      role: active.role,
    },
  };
}

/** Switch the session's company; only to a company the user actively belongs to. */
export async function setActiveCompany(
  auth: Auth,
  db: PrismaClient,
  headers: Headers,
  companyId: string,
): Promise<boolean> {
  const session = await auth.api.getSession({ headers });
  if (!session) return false;
  const membership = await db.membership.findFirst({
    where: { userId: session.user.id, companyId, isActive: true },
    select: { id: true },
  });
  if (!membership) return false;
  await db.authSession.update({
    where: { id: session.session.id },
    data: { activeCompanyId: companyId },
  });
  return true;
}
