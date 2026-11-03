import { createHash, randomBytes } from "node:crypto";
import type {
  AccountTokenPurpose,
  Prisma,
} from "../../../../../packages/database/src/generated/prisma/client";

/** 256-bit random token for an emailed link; only its SHA-256 is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const TOKEN_TTL_MS: Record<AccountTokenPurpose, number> = {
  email_verification: 24 * 3_600_000,
  password_reset: 3_600_000,
};

/** Issue a fresh token, superseding any live one for the same purpose. */
export async function issueToken(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: AccountTokenPurpose,
  now = new Date(),
): Promise<string> {
  await tx.accountToken.updateMany({
    where: { userId, purpose, consumedAt: null, supersededAt: null },
    data: { supersededAt: now },
  });
  const token = newToken();
  await tx.accountToken.create({
    data: {
      userId,
      purpose,
      tokenHash: tokenDigest(token),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
    },
  });
  return token;
}

/**
 * Consume a live, unexpired token exactly once. Returns its user, or null for
 * an unknown, expired, consumed or superseded token (all look the same).
 */
export async function consumeToken(
  tx: Prisma.TransactionClient,
  token: string,
  purpose: AccountTokenPurpose,
  now = new Date(),
): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const rows = await tx.accountToken.updateManyAndReturn({
    where: {
      tokenHash: tokenDigest(token),
      purpose,
      consumedAt: null,
      supersededAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
    select: { userId: true },
  });
  return rows[0]?.userId ?? null;
}
