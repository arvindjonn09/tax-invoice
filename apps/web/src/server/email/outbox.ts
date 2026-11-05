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
 * stays under a configurable cap (docs/ops/email.md).
 */
export const DEFAULT_MAX_PER_HOUR = 40;
const HOUR_MS = 3_600_000;
/** First provider-wide pause after a throttling reply; doubles per repeat. */
export const RATE_LIMIT_PAUSE_MS = 15 * 60_000;
/** The longest provider-wide pause. */
export const MAX_PAUSE_MS = 4 * HOUR_MS;
/** Zoho's "outgoing blocked" lasts up to an hour, so never wait less. */
export const BLOCKED_PAUSE_MS = HOUR_MS;
/**
 * A row that keeps meeting throttling replies stops pausing the queue after
 * this many: from then on its 4xx replies count as ordinary attempts, so it
 * can end `failed` like any other (owner decision pending on #266).
 */
export const MAX_RATE_LIMITED_PER_ROW = 8;
/** One lock serialises claims across dispatchers, so the cap is exact. */
const PACING_LOCK_KEY = 259_001;

/**
 * Account emails a user is waiting on go first, ahead of trial reminders and
 * notices. claimOne's ORDER BY uses this list directly.
 */
export const ACCOUNT_EMAIL_KINDS = [
  "verify_email",
  "account_exists",
  "password_reset",
  "password_changed",
] as const;

let badCapLogged = false;

/**
 * EMAIL_MAX_PER_HOUR, a whole number from 1. Anything else (including 0) is
 * a configuration error: the default is used and an error is logged once.
 */
export function maxPerHourFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.EMAIL_MAX_PER_HOUR?.trim();
  if (!raw) return DEFAULT_MAX_PER_HOUR;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1) return value;
  if (!badCapLogged) {
    badCapLogged = true;
    log("error", "email.config_invalid", {
      setting: "EMAIL_MAX_PER_HOUR",
      using: DEFAULT_MAX_PER_HOUR,
    });
  }
  return DEFAULT_MAX_PER_HOUR;
}

/** Zoho's block reply (`554 5.1.8 Email Outgoing Blocked`) and its kin. */
const BLOCKED_REPLY =
  /\b5\.1\.8\b|\boutgoing\s+(?:mail\s+|email\s+)?blocked\b|\b(?:account|sending)\s+(?:is\s+|has\s+been\s+)?blocked\b/i;
/** A 5xx that is really a limit: narrow phrases, whole words only. */
const LIMIT_REPLY =
  /\bquota\b|\brate[ -]?limit(?:ed)?\b|\bsending\s+limit\b|\btoo\s+many\s+(?:messages|emails|mails|recipients|connections)\b|\blimit\s+(?:exceeded|reached)\b|\bexceeded\s+(?:the\s+|your\s+)?(?:\w+\s+)?limit\b|\bunusual\s+sending\s+(?:rate|activity)\b/i;

export type SendErrorClass = "throttled" | "blocked" | "other";

/**
 * Is this send error the provider throttling or blocking us? SMTP 4xx is
 * transient by definition; a 5xx counts only when its text says so. Only the
 * decision leaves this function, never the reply text.
 */
export function classifySendError(error: unknown): SendErrorClass {
  const record = (error ?? {}) as {
    responseCode?: unknown;
    response?: unknown;
  };
  const code = Number(record.responseCode);
  const text = String(record.response ?? "");
  if (code >= 500 && code < 600 && BLOCKED_REPLY.test(text)) return "blocked";
  if (code >= 400 && code < 500) return "throttled";
  if (code >= 500 && code < 600 && LIMIT_REPLY.test(text)) return "throttled";
  return "other";
}

export function isRateLimited(error: unknown): boolean {
  return classifySendError(error) !== "other";
}

/** The provider-wide pause after the nth throttling reply in a row (n ≥ 1). */
export function pauseMs(streak: number, kind: "throttled" | "blocked"): number {
  const backoff = Math.min(
    RATE_LIMIT_PAUSE_MS * 2 ** Math.max(0, streak - 1),
    MAX_PAUSE_MS,
  );
  return kind === "blocked" ? Math.max(backoff, BLOCKED_PAUSE_MS) : backoff;
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

type Claim =
  | { kind: "row"; id: string }
  | { kind: "none" }
  | { kind: "paced" }
  | { kind: "paused"; until: Date };

/**
 * Claim ONE due row, leasing it until `now + STALE_SENDING_MS`. Under one
 * advisory lock it first honours the provider-wide pause (so rows queued
 * during it wait too), then the rolling-hour cap, counted from
 * email_send_attempts so failed and throttled sends count as well. Each
 * claim records its attempt in the same transaction. Account emails first.
 */
async function claimOne(
  db: PrismaClient,
  now: Date,
  maxPerHour: number,
): Promise<Claim> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PACING_LOCK_KEY})`;
    const [state] = await tx.$queryRaw<{ paused_until: Date | null }[]>`
      SELECT paused_until FROM email_dispatch_state WHERE id = 1`;
    if (state?.paused_until && state.paused_until > now)
      return { kind: "paused", until: state.paused_until } as const;
    const [usage] = await tx.$queryRaw<{ used: number }[]>`
      SELECT count(*)::int AS used FROM email_send_attempts
      WHERE attempted_at > ${new Date(now.getTime() - HOUR_MS)}`;
    if ((usage?.used ?? 0) >= maxPerHour) return { kind: "paced" } as const;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE email_outbox SET status = 'sending', next_attempt_at = ${new Date(now.getTime() + STALE_SENDING_MS)}
      WHERE id = (
        SELECT id FROM email_outbox
        WHERE (status = 'pending' AND next_attempt_at <= ${now})
           OR (status = 'sending' AND next_attempt_at <= ${now})
        ORDER BY
          CASE WHEN kind = ANY(${[...ACCOUNT_EMAIL_KINDS]}::text[]) THEN 0 ELSE 1 END,
          next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    const id = rows[0]?.id;
    if (!id) return { kind: "none" } as const;
    await tx.$executeRaw`INSERT INTO email_send_attempts (attempted_at) VALUES (${now})`;
    await tx.$executeRaw`
      DELETE FROM email_send_attempts
      WHERE attempted_at < ${new Date(now.getTime() - 2 * HOUR_MS)}`;
    return { kind: "row", id } as const;
  });
}

/**
 * Send due emails. Each row is claimed and leased on its own with FOR UPDATE
 * SKIP LOCKED just before it is sent, so a lease (10 min) always outlasts
 * one SMTP send (at most ~60 s of timeouts) and a slow batch can't let
 * another dispatcher reclaim rows this one hasn't reached yet. Payloads are
 * nulled as soon as a row is sent.
 *
 * #259: at most `maxPerHour` SMTP attempts in any rolling hour (the rest
 * stay pending), account emails first, and an address suppressed after it
 * was queued is never sent to. A throttling or block reply sets a
 * provider-wide pause (doubling per repeat, at least an hour for a block),
 * puts that row behind the others and uses no attempt, until the row has
 * met MAX_RATE_LIMITED_PER_ROW of them.
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
  paused: boolean;
  rateLimited: boolean;
}> {
  let sent = 0;
  let failed = 0;
  let paced = false;
  let paused = false;
  let rateLimited = false;
  for (let index = 0; index < limit; index += 1) {
    const claim = await claimOne(db, now(), maxPerHour);
    if (claim.kind === "paced") {
      paced = true;
      break;
    }
    if (claim.kind === "paused") {
      paused = true;
      break;
    }
    if (claim.kind === "none") break;
    const { id } = claim;
    const row = await db.emailOutbox.findUnique({
      where: { id },
      select: {
        kind: true,
        attempts: true,
        rateLimitedCount: true,
        payloadCiphertext: true,
      },
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
      // A send went through: the next throttling reply starts the backoff again.
      await db.emailDispatchState.updateMany({
        where: { id: 1, pauseStreak: { gt: 0 } },
        data: { pauseStreak: 0, updatedAt: now() },
      });
      sent += 1;
    } catch (error) {
      const kind = classifySendError(error);
      // A block is account-wide, never this row's fault, so it always pauses.
      if (
        kind === "blocked" ||
        (kind === "throttled" &&
          row.rateLimitedCount < MAX_RATE_LIMITED_PER_ROW)
      ) {
        // Not this message's fault: no attempt used, never `failed` here.
        // The pause lives in email_dispatch_state, so every row waits,
        // including ones queued during it; this row goes behind the others.
        const at = now();
        const until = await db.$transaction(async (tx) => {
          const state = await tx.emailDispatchState.update({
            where: { id: 1 },
            data: { pauseStreak: { increment: 1 }, updatedAt: at },
          });
          const pausedUntil = new Date(
            at.getTime() + pauseMs(state.pauseStreak, kind),
          );
          await tx.emailDispatchState.update({
            where: { id: 1 },
            data: { pausedUntil },
          });
          await tx.emailOutbox.update({
            where: { id },
            data: {
              status: "pending",
              rateLimitedCount: { increment: 1 },
              nextAttemptAt: new Date(
                pausedUntil.getTime() +
                  RATE_LIMIT_PAUSE_MS * (row.rateLimitedCount + 1),
              ),
              lastError: errorClass(error),
            },
          });
          return pausedUntil;
        });
        // `error`: ADR D7 says the dispatcher alerts when limits are hit.
        log(
          "error",
          kind === "blocked" ? "email.provider_blocked" : "email.rate_limited",
          {
            outboxId: id,
            kind: row.kind,
            transport: transport.name,
            error: errorClass(error),
            pausedUntil: until.toISOString(),
          },
        );
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
        ...(kind !== "other" ? { throttledRowCapped: true } : {}),
      });
    }
  }
  return { sent, failed, paced, paused, rateLimited };
}
