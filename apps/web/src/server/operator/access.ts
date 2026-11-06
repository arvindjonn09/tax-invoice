import { createHash } from "node:crypto";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";

/** Sent by the /operator/mfa page with the /two-factor/enable request. */
export const ENROLMENT_CODE_HEADER = "x-jobflow-enrolment-code";

type Env = Readonly<Record<string, string | undefined>>;
type Db = Pick<PrismaClient, "authSession" | "user" | "platformOperator">;

/** JOBFLOW_OPERATOR_USER_IDS: the second key (ADR 0004 D5). Comma separated. */
export function operatorAllowlist(env: Env): ReadonlySet<string> {
  return new Set(
    (env.JOBFLOW_OPERATOR_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean),
  );
}

export type OperatorCheck = {
  env: Env;
  /** Production also needs TOTP; pass false only for the enrolment step. */
  production: boolean;
  /** The calling session. In production, it must itself have passed TOTP. */
  sessionId?: string;
};

/**
 * ADR 0004 D5: an active platform_operators row AND the environment allowlist
 * AND a verified email, plus, in production, TOTP passed by this session. A
 * session from before enrolment never qualifies, even once the user has TOTP.
 * Revocation takes effect on the next request, because nothing here is cached.
 */
export async function isOperator(
  db: Db,
  userId: string,
  { env, production, sessionId }: OperatorCheck,
): Promise<boolean> {
  if (!operatorAllowlist(env).has(userId.toLowerCase())) return false;
  const operator = await db.platformOperator.findUnique({
    where: { userId },
    select: {
      revokedAt: true,
      user: { select: { emailVerified: true, twoFactorEnabled: true } },
    },
  });
  if (!operator || operator.revokedAt || !operator.user.emailVerified) {
    return false;
  }
  if (!production) return true;
  if (!operator.user.twoFactorEnabled || !sessionId) return false;
  const session = await db.authSession.findFirst({
    where: { id: sessionId, userId },
    select: { mfaVerifiedAt: true },
  });
  return Boolean(session?.mfaVerifiedAt);
}

export const enrolmentCodeDigest = (code: string) =>
  createHash("sha256").update(code).digest("hex");

/** Spends a live code of this user's exactly once. */
export async function consumeEnrolmentCode(
  db: Pick<PrismaClient, "operatorEnrolmentCode">,
  userId: string,
  code: string,
  now = new Date(),
): Promise<boolean> {
  const { count } = await db.operatorEnrolmentCode.updateMany({
    where: {
      userId,
      codeHash: enrolmentCodeDigest(code),
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  return count === 1;
}
