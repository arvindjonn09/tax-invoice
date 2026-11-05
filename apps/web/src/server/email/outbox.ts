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

/**
 * #259 pacing. Zoho Mail allows 50–500 messages per rolling hour (dynamic),
 * and going over blocks ALL sending for up to an hour, so the dispatcher
 * stays under a configurable cap (docs/research/email-provider.md).
 */
export const DEFAULT_MAX_PER_HOUR = 40;
const HOUR_MS = 3_600_000;
/** After a throttling reply, nothing is tried again for this long. */
export const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
/** One lock serialises claims across dispatchers, so the cap is exact. */
const PACING_LOCK_KEY = 259_001;

/**
 * Account emails a user is waiting on go first, ahead of trial reminders and
 * notices. Keep in sync with the ORDER BY in claimOne.
 */
export const ACCOUNT_EMAIL_KINDS = [
  "verify_email",
  "account_exists",
  "password_reset",
  "password_changed",
] as const;

/** EMAIL_MAX_PER_HOUR, or the default; never below 1. */
export function maxPerHourFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const value = Number(env.EMAIL_MAX_PER_HOUR ?? "");
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_MAX_PER_HOUR;
}

/**
 * Is this send error the provider throttling us? SMTP 4xx (transient), or a
 * 554 whose text mentions a limit (Zoho's "outgoing mail quota exceeded").
 * Only the decision leaves this function, never the reply text.
 */
export function isRateLimited(error: unknown): boolean {
  const record = (error ?? {}) as {
    responseCode?: unknown;
    response?: unknown;
  };
  const code = Number(record.responseCode);
  if (code >= 400 && code < 500) return true;
  return (
    code === 554 &&
    /limit|quota|rate|too many|exceed/i.test(String(record.response ?? ""))
  );
}

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
 * Claim ONE due row, leasing it until `now + STALE_SENDING_MS`, unless the
 * rolling-hour cap is used up ("paced"): sent in the last hour plus rows in
 * flight. Account emails are claimed first.
 */
async function claimOne(
  db: PrismaClient,
  now: Date,
  maxPerHour: number,
): Promise<string | null | "paced"> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PACING_LOCK_KEY})`;
    const [usage] = await tx.$queryRaw<{ used: number }[]>`
      SELECT count(*)::int AS used FROM email_outbox
      WHERE (status = 'sent' AND sent_at > ${new Date(now.getTime() - HOUR_MS)})
         OR (status = 'sending' AND next_attempt_at > ${now})`;
    if ((usage?.used ?? 0) >= maxPerHour) return "paced";
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE email_outbox SET status = 'sending', next_attempt_at = ${new Date(now.getTime() + STALE_SENDING_MS)}
      WHERE id = (
        SELECT id FROM email_outbox
        WHERE (status = 'pending' AND next_attempt_at <= ${now})
           OR (status = 'sending' AND next_attempt_at <= ${now})
        ORDER BY
          CASE WHEN kind IN ('verify_email', 'account_exists', 'password_reset', 'password_changed') THEN 0 ELSE 1 END,
          next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    return rows[0]?.id ?? null;
  });
}

/**
 * Send due emails. Each row is claimed and leased on its own with FOR UPDATE
 * SKIP LOCKED just before it is sent, so a lease (10 min) always outlasts
 * one SMTP send (at most ~60 s of timeouts) and a slow batch can't let
 * another dispatcher reclaim rows this one hasn't reached yet. Payloads are
 * nulled as soon as a row is sent.
 *
 * #259: at most `maxPerHour` in any rolling hour (rows beyond it stay
 * pending), account emails first, a throttling reply pauses everything for
 * RATE_LIMIT_PAUSE_MS without using up attempts, and an address suppressed
 * after it was queued is never sent to.
 */
export async function dispatchOutbox(
  db: PrismaClient,
  transport: EmailTransport,
  secret: string,
  {
    limit = 20,
    maxPerHour = DEFAULT_MAX_PER_HOUR,
    now = () => new Date(),
  }: { limit?: number; maxPerHour?: number; now?: () => Date } = {},
): Promise<{
  sent: number;
  failed: number;
  paced: boolean;
  rateLimited: boolean;
}> {
  let sent = 0;
  let failed = 0;
  let paced = false;
  let rateLimited = false;
  for (let index = 0; index < limit; index += 1) {
    const id = await claimOne(db, now(), maxPerHour);
    if (id === "paced") {
      paced = true;
      break;
    }
    if (!id) break;
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
      const suppressed = await db.emailSuppression.findUnique({
        where: { addressHash: addressDigest(secret, message.to) },
        select: { reason: true },
      });
      if (suppressed) {
        // Suppressed after it was queued (a bounce, a complaint, by hand).
        await db.emailOutbox.update({
          where: { id },
          data: { status: "cancelled", payloadCiphertext: null },
        });
        log("info", "email.suppressed", { outboxId: id, kind: row.kind });
        continue;
      }
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
      if (isRateLimited(error)) {
        // Not this message's fault: no attempt used, never `failed`. Every
        // pending row waits too, since the provider would refuse them all.
        const until = new Date(now().getTime() + RATE_LIMIT_PAUSE_MS);
        await db.$transaction([
          db.emailOutbox.update({
            where: { id },
            data: {
              status: "pending",
              nextAttemptAt: until,
              lastError: errorClass(error),
            },
          }),
          db.emailOutbox.updateMany({
            where: { status: "pending", nextAttemptAt: { lt: until } },
            data: { nextAttemptAt: until },
          }),
        ]);
        log("warn", "email.rate_limited", {
          outboxId: id,
          kind: row.kind,
          transport: transport.name,
          error: errorClass(error),
          pausedUntil: until.toISOString(),
        });
        rateLimited = true;
        break;
      }
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
  return { sent, failed, paced, rateLimited };
}
