import type {
  MembershipRole,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { type Auth, DEMO_EMAIL, isProductionEnvironment } from "./config";

/**
 * The company's trial access for this request (#221, ADR 0004 D3). `readOnly`
 * is computed by the database clock in the same query as the membership, so
 * the banner and the write guard agree. Demo and pre-M6 companies are always
 * `unrestricted` and never read-only.
 */
export type CompanyAccess = {
  mode: "unrestricted" | "trial";
  /** Last Sydney day of the trial (`YYYY-MM-DD`), null when unrestricted. */
  lastDay: string | null;
  readOnly: boolean;
};

/** Who is acting, and in which company, for one request. */
export type Actor = {
  userId: string;
  sessionId: string;
  companyId: string;
  role: MembershipRole;
  access: CompanyAccess;
};

type MembershipAccessRow = {
  company_id: string;
  role: MembershipRole;
  access_mode: "unrestricted" | "trial";
  last_day: string | null;
  read_only: boolean;
};

export type ActorResolution =
  | { status: "signed-out" }
  /** Signed in, but the email address is not verified yet (ADR 0004 D1). */
  | { status: "unverified"; userId: string; email: string }
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
  if (!isVerified(session.user)) {
    return { status: "unverified", userId, email: session.user.email };
  }
  // One query: active memberships with each company's trial state, judged
  // by the database clock (the same clock the commit-time guard uses).
  const rows = await db.$queryRaw<MembershipAccessRow[]>`
    SELECT m.company_id::text AS company_id, m.role::text AS role,
           c.access_mode::text AS access_mode,
           to_char(c.trial_last_day, 'YYYY-MM-DD') AS last_day,
           (c.access_mode = 'trial' AND c.read_only_from <= now()) AS read_only
    FROM memberships m JOIN companies c ON c.id = m.company_id
    WHERE m.user_id = ${userId}::uuid AND m.is_active
    ORDER BY m.created_at, m.id`;
  const memberships = rows.map((row) => ({
    companyId: row.company_id,
    role: row.role,
    access: {
      mode: row.access_mode,
      lastDay: row.access_mode === "trial" ? row.last_day : null,
      readOnly: row.read_only === true,
    } satisfies CompanyAccess,
  }));
  if (memberships.length === 0) return { status: "no-membership", userId };
  const remembered = session.session.activeCompanyId;
  const active =
    memberships.find((membership) => membership.companyId === remembered) ??
    (memberships.length === 1 ? memberships[0] : undefined);
  if (!active) {
    return {
      status: "choose-company",
      userId,
      companies: memberships.map(({ companyId, role }) => ({
        companyId,
        role,
      })),
    };
  }
  return {
    status: "active",
    actor: {
      userId,
      sessionId: session.session.id,
      companyId: active.companyId,
      role: active.role,
      access: active.access,
    },
  };
}

/** Reserved TLDs (RFC 2606/6761) can never receive email. */
const UNDELIVERABLE_EMAIL = /\.(test|example|invalid|localhost)$/i;

/**
 * Verified email is required for every account (S3 AC6). Synthetic demo and
 * test identities on reserved TLDs can't receive email, so they are exempt
 * outside production only; production sign-up refuses those domains.
 */
export function isVerified(
  user: { email: string; emailVerified: boolean },
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (user.emailVerified) return true;
  return (
    (DEMO_EMAIL.test(user.email) || UNDELIVERABLE_EMAIL.test(user.email)) &&
    !isProductionEnvironment(env)
  );
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
