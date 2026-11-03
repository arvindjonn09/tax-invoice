import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { log } from "../log";
import { addressDigest, decryptPayload, encryptPayload } from "./crypto";
import type { EmailMessage, EmailTransport } from "./transport";

export const MAX_ATTEMPTS = 8;
/** A row left in `sending` this long (crashed sender) is retried. */
const STALE_SENDING_MS = 10 * 60_000;

/** Backoff after the nth failed attempt: 1, 2, 4 … minutes, capped at 6 hours. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

/**
 * Queue an email inside the caller's transaction, so it is sent only if the
 * change that caused it commits. Idempotent per `dedupeKey`. Suppressed
 * addresses are recorded as cancelled without a payload.
 */
export async function enqueueEmail(
  tx: Prisma.TransactionClient,
  secret: string,
  input: {
    kind: string;
    dedupeKey: string;
    message: EmailMessage;
    userId?: string;
    companyId?: string;
  },
): Promise<void> {
  const suppressed = await tx.emailSuppression.findUnique({
    where: { addressHash: addressDigest(secret, input.message.to) },
    select: { addressHash: true },
  });
  await tx.emailOutbox.upsert({
    where: { dedupeKey: input.dedupeKey },
    update: {},
    create: {
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
      status: suppressed ? "cancelled" : "pending",
      payloadCiphertext: suppressed
        ? null
        : new Uint8Array(encryptPayload(secret, input.message)),
    },
  });
}

/** Rows the server may cancel before they are sent (e.g. a superseded verification link). */
export async function cancelPendingEmail(
  tx: Prisma.TransactionClient,
  where: { userId: string; kind: string },
): Promise<void> {
  await tx.emailOutbox.updateMany({
    where: { ...where, status: "pending" },
    data: { status: "cancelled", payloadCiphertext: null },
  });
}

function errorClass(error: unknown): string {
  const record = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    name?: unknown;
  };
  const parts = [record.name, record.code, record.responseCode]
    .filter((part) => typeof part === "string" || typeof part === "number")
    .map(String);
  return (parts.join(":") || "Error").slice(0, 100);
}

/**
 * Send due emails. Rows are claimed with FOR UPDATE SKIP LOCKED, so several
 * dispatchers (after() callbacks, the jobs:run sweep, other instances) never
 * send the same row twice. Payloads are nulled as soon as a row is sent.
 */
export async function dispatchOutbox(
  db: PrismaClient,
  transport: EmailTransport,
  secret: string,
  {
    limit = 20,
    now = () => new Date(),
  }: { limit?: number; now?: () => Date } = {},
): Promise<{ sent: number; failed: number }> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE email_outbox SET status = 'sending', next_attempt_at = ${new Date(now().getTime() + STALE_SENDING_MS)}
    WHERE id IN (
      SELECT id FROM email_outbox
      WHERE (status = 'pending' AND next_attempt_at <= ${now()})
         OR (status = 'sending' AND next_attempt_at <= ${now()})
      ORDER BY next_attempt_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  let sent = 0;
  let failed = 0;
  for (const { id } of claimed) {
    const row = await db.emailOutbox.findUnique({
      where: { id },
      select: { kind: true, attempts: true, payloadCiphertext: true },
    });
    if (!row?.payloadCiphertext) {
      await db.emailOutbox.update({
        where: { id },
        data: { status: "cancelled", payloadCiphertext: null },
      });
      continue;
    }
    const attempts = row.attempts + 1;
    try {
      const message = decryptPayload(secret, row.payloadCiphertext);
      const { providerMessageId } = await transport.send(message);
      await db.emailOutbox.update({
        where: { id },
        data: {
          status: "sent",
          attempts,
          sentAt: now(),
          providerMessageId,
          payloadCiphertext: null,
          lastError: null,
        },
      });
      sent += 1;
    } catch (error) {
      const final = attempts >= MAX_ATTEMPTS;
      await db.emailOutbox.update({
        where: { id },
        data: {
          status: final ? "failed" : "pending",
          attempts,
          lastError: errorClass(error),
          nextAttemptAt: new Date(now().getTime() + retryDelayMs(attempts)),
          ...(final ? { payloadCiphertext: null } : {}),
        },
      });
      failed += 1;
      log(final ? "error" : "warn", "email.send_failed", {
        outboxId: id,
        kind: row.kind,
        attempts,
        transport: transport.name,
        error: errorClass(error),
      });
    }
  }
  return { sent, failed };
}
