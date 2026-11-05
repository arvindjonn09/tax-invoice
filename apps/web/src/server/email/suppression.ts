import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { addressDigest } from "./crypto";

// #259: the host-side suppression list. Only the address HMAC is stored, in
// email_suppressions and in the platform audit trail; the address itself is
// never written anywhere. The outbox checks the list when an email is queued
// and again just before it is sent.

export const SUPPRESSION_REASONS = ["bounce", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** A plausible single address: no spaces or commas, one @, at most 254. */
export function checkAddress(address: string): string {
  const trimmed = address.trim();
  if (
    trimmed.length > 254 ||
    !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(trimmed)
  )
    throw new Error("Give one email address, like name@example.com");
  return trimmed;
}

/** Who ran the CLI: an OS user name or `--by` value, recorded in the audit row. */
export function checkRanBy(ranBy: string): string {
  const trimmed = ranBy.trim();
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(trimmed))
    throw new Error("--by must be 1–64 letters, digits, dots, dashes, @ or _");
  return trimmed;
}

/** Suppress an address (or change its reason). Audited; idempotent. */
export async function suppressAddress(
  db: PrismaClient,
  secret: string,
  address: string,
  reason: SuppressionReason,
  ranBy: string,
): Promise<{ addressHash: string; changed: boolean }> {
  if (!SUPPRESSION_REASONS.includes(reason))
    throw new Error("Reason must be bounce, complaint or manual");
  const addressHash = addressDigest(secret, checkAddress(address));
  return db.$transaction(async (tx) => {
    const existing = await tx.emailSuppression.findUnique({
      where: { addressHash },
      select: { reason: true },
    });
    if (existing?.reason === reason) return { addressHash, changed: false };
    await tx.emailSuppression.upsert({
      where: { addressHash },
      create: { addressHash, reason },
      update: { reason },
    });
    await tx.platformAuditEvent.create({
      data: {
        actorKind: "operator",
        action: "email.suppressed",
        metadata: {
          addressHash,
          reason,
          previousReason: existing?.reason ?? null,
          via: "cli",
          ranBy: checkRanBy(ranBy),
        },
      },
    });
    return { addressHash, changed: true };
  });
}

/** Remove an address from the list. Audited; a no-op when it isn't there. */
export async function unsuppressAddress(
  db: PrismaClient,
  secret: string,
  address: string,
  ranBy: string,
): Promise<{ addressHash: string; changed: boolean }> {
  const addressHash = addressDigest(secret, checkAddress(address));
  return db.$transaction(async (tx) => {
    const removed = await tx.emailSuppression.deleteMany({
      where: { addressHash },
    });
    if (removed.count === 0) return { addressHash, changed: false };
    await tx.platformAuditEvent.create({
      data: {
        actorKind: "operator",
        action: "email.unsuppressed",
        metadata: { addressHash, via: "cli", ranBy: checkRanBy(ranBy) },
      },
    });
    return { addressHash, changed: true };
  });
}
