import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import type { Auth } from "../auth/config";
import { createCredentialUser } from "../auth/credentials";
import { privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import { enqueueEmail, cancelPendingEmail } from "../email/outbox";
import {
  HttpError,
  readJson,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../http/guards";
import { clientIp, hit } from "../http/throttle";
import { log, safeError } from "../log";
import { accountExistsEmail, verificationEmail } from "./emails";
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
  legalTextIsPlaceholder,
} from "./terms";
import { consumeToken, issueToken } from "./tokens";

export type AccountDependencies = {
  db: () => PrismaClient;
  auth: () => Auth;
  trustedOrigins: () => readonly string[];
  /** Public origin used in emailed links (BETTER_AUTH_URL). */
  appUrl: () => string;
  emailSecret: () => string;
  production: () => boolean;
  /** Sends queued email after the response (next/server after()). */
  dispatch: () => void;
  isBreached: (password: string) => Promise<boolean>;
  verifyTurnstile: (
    token: string | undefined,
    action: string,
    ip: string | null,
  ) => Promise<boolean>;
};

const BODY_LIMIT = 4096;
const RESERVED_TLD = /\.(test|example|invalid|localhost)$/i;
const CONTROL = /\p{Cc}/u;

const name = z
  .string()
  .trim()
  .min(1, "Enter your name")
  .max(200, "Use 200 characters or fewer")
  .refine((value) => !CONTROL.test(value), "Remove unusual characters");
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, "Use 320 characters or fewer")
  .pipe(z.email("Enter a valid email address"));
const password = z
  .string()
  .min(12, "Use at least 12 characters")
  .max(128, "Use 128 characters or fewer");

const SignUp = z
  .object({
    name,
    email,
    password,
    passwordConfirmation: z.string(),
    acceptTerms: z.literal(true, {
      error: "Accept the Terms of Service and Privacy Policy",
    }),
    termsVersion: z.string().max(40),
    privacyVersion: z.string().max(40),
    turnstileToken: z.string().max(2048).optional(),
  })
  .strict()
  .refine((value) => value.password === value.passwordConfirmation, {
    path: ["passwordConfirmation"],
    message: "Passwords don't match",
  });
const Verify = z.object({ token: z.string().max(100) }).strict();
const Resend = z
  .object({ email, turnstileToken: z.string().max(2048).optional() })
  .strict();

/** Shared guard for public account endpoints: CSRF, size, errors, no-store. */
function publicRoute(
  deps: AccountDependencies,
  handler: (request: Request) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      requireTrustedOrigin(request, deps.trustedOrigins());
      requireBodyWithin(request, BODY_LIMIT);
      return await handler(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return privateJson({ error: error.message }, { status: error.status });
      }
      const reference = crypto.randomUUID();
      log("error", "account.unhandled", {
        reference,
        path: new URL(request.url).pathname,
        error: safeError(error),
      });
      return privateJson(
        { error: "Something went wrong. Try again.", reference },
        { status: 500 },
      );
    }
  };
}

async function body(request: Request): Promise<unknown> {
  return readJson(request, BODY_LIMIT).catch((error: unknown) => {
    if (error instanceof HttpError && error.status !== 400) throw error;
    return null;
  });
}

/** Count against a limit; true when over it. */
async function over(
  db: PrismaClient,
  key: string,
  windowSeconds: number,
  max: number,
): Promise<boolean> {
  return (await hit(db, key, { windowSeconds, max })) > max;
}

const tooMany = (retryAfterSeconds: number) =>
  privateJson(
    {
      error: "Too many attempts. Try again later.",
      retryAfterSeconds,
    },
    { status: 429, headers: { "retry-after": String(retryAfterSeconds) } },
  );

/** The same 202 for every outcome, so responses never reveal an account. */
const checkEmail = () =>
  privateJson({ status: "check-email" }, { status: 202 });

/** Prisma P2002 or PostgreSQL 23505, however the adapter wraps it. */
function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const row = current as Record<string, unknown>;
    if (
      row.code === "P2002" ||
      row.code === "23505" ||
      row.originalCode === "23505"
    ) {
      return true;
    }
    current = row.cause ?? row.meta;
  }
  return false;
}

async function sendVerification(
  deps: AccountDependencies,
  user: { id: string; email: string },
): Promise<void> {
  await deps.db().$transaction(async (tx) => {
    await cancelPendingEmail(tx, { userId: user.id, kind: "verify_email" });
    const token = await issueToken(tx, user.id, "email_verification");
    await enqueueEmail(tx, deps.emailSecret(), {
      kind: "verify_email",
      dedupeKey: `verify_email:${user.id}:${crypto.randomUUID()}`,
      userId: user.id,
      message: verificationEmail(user.email, deps.appUrl(), token),
    });
    await tx.platformAuditEvent.create({
      data: {
        actorKind: "user",
        userId: user.id,
        action: "account.verification_sent",
      },
    });
  });
}

/**
 * Per-account resend limits (S3 AC5): 1 per minute and 5 per day. Returns
 * the seconds to wait, or null when a resend is allowed now.
 */
async function resendWait(
  db: PrismaClient,
  userId: string,
): Promise<number | null> {
  if (await over(db, `verify:resend:minute:${userId}`, 60, 1)) return 60;
  if (await over(db, `verify:resend:day:${userId}`, 86_400, 5)) return 3600;
  return null;
}

/** POST /api/account/sign-up (S2). */
export function signUp(deps: AccountDependencies) {
  return publicRoute(deps, async (request) => {
    if (deps.production() && legalTextIsPlaceholder()) {
      return privateJson(
        {
          error: "Sign-up isn't open yet. Request early access instead.",
          code: "signup_unavailable",
        },
        { status: 503 },
      );
    }
    const db = deps.db();
    const ip = clientIp(request.headers);
    if (await over(db, `signup:ip:${ip ?? "unknown"}`, 3600, 5)) {
      return tooMany(3600);
    }
    const parsed = SignUp.safeParse(await body(request));
    if (!parsed.success) return invalid(parsed.error);
    const input = parsed.data;
    if (
      input.termsVersion !== TERMS_VERSION ||
      input.privacyVersion !== PRIVACY_VERSION
    ) {
      return privateJson(
        {
          error: "The terms have changed. Reload the page and try again.",
          code: "terms_changed",
        },
        { status: 400 },
      );
    }
    // Reserved TLDs can't receive mail and skip verification outside production.
    if (RESERVED_TLD.test(input.email)) {
      return privateJson(
        {
          error: "Check the highlighted fields",
          fields: { email: "Enter a valid email address" },
        },
        { status: 400 },
      );
    }
    if (!(await deps.verifyTurnstile(input.turnstileToken, "signup", ip))) {
      return privateJson(
        {
          error: "We couldn't confirm you're not a robot. Try again.",
          code: "turnstile_failed",
        },
        { status: 400 },
      );
    }
    if (await deps.isBreached(input.password)) {
      return privateJson(
        {
          error: "Check the highlighted fields",
          fields: {
            password:
              "This password has appeared in a data breach. Choose a different one.",
          },
        },
        { status: 400 },
      );
    }
    const existing = await db.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    let createdId: string | null = null;
    if (!existing) {
      try {
        createdId = await db.$transaction(async (tx) => {
          const user = await createCredentialUser(tx, {
            email: input.email,
            name: input.name,
            password: input.password,
          });
          await tx.termsAcceptance.create({
            data: {
              userId: user.id,
              termsVersion: input.termsVersion,
              privacyVersion: input.privacyVersion,
            },
          });
          const token = await issueToken(tx, user.id, "email_verification");
          await enqueueEmail(tx, deps.emailSecret(), {
            kind: "verify_email",
            dedupeKey: `verify_email:${user.id}:signup`,
            userId: user.id,
            message: verificationEmail(user.email, deps.appUrl(), token),
          });
          await tx.platformAuditEvent.create({
            data: {
              actorKind: "anonymous",
              userId: user.id,
              action: "account.signed_up",
              metadata: {
                termsVersion: input.termsVersion,
                privacyVersion: input.privacyVersion,
              },
            },
          });
          return user.id;
        });
      } catch (error) {
        // A concurrent sign-up won the race: treat as an existing account.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    if (!createdId) {
      // Spend the same hashing work as a new account, so timing doesn't tell.
      if (existing) await hashPassword(input.password);
      const owner = await db.user.findUniqueOrThrow({
        where: { email: input.email },
        select: { id: true, email: true },
      });
      const hour = Math.floor(Date.now() / 3_600_000);
      // Silent per-recipient cap (1/h via the dedupe key, 3/day here), so
      // many IPs can't flood one inbox; the response is the same either way.
      const capped = await over(
        db,
        `signup:existing:day:${owner.id}`,
        86_400,
        3,
      );
      if (!capped)
        await db
          .$transaction(async (tx) => {
            await enqueueEmail(tx, deps.emailSecret(), {
              kind: "account_exists",
              // At most one "already exists" email per account per hour.
              dedupeKey: `account_exists:${owner.id}:${hour}`,
              userId: owner.id,
              message: accountExistsEmail(owner.email, deps.appUrl()),
            });
            await tx.platformAuditEvent.create({
              data: {
                actorKind: "anonymous",
                userId: owner.id,
                action: "account.sign_up_existing",
              },
            });
          })
          // A concurrent request already queued this hour's email.
          .catch((error: unknown) => {
            if (!isUniqueViolation(error)) throw error;
          });
    }
    deps.dispatch();
    return checkEmail();
  });
}

/** POST /api/account/verify-email (S3). */
export function verifyEmail(deps: AccountDependencies) {
  return publicRoute(deps, async (request) => {
    const db = deps.db();
    const ip = clientIp(request.headers) ?? "unknown";
    if (await over(db, `verify:ip:${ip}`, 3600, 30)) return tooMany(3600);
    const parsed = Verify.safeParse(await body(request));
    const userId = parsed.success
      ? await db.$transaction(async (tx) => {
          const id = await consumeToken(
            tx,
            parsed.data.token,
            "email_verification",
          );
          if (!id) return null;
          await tx.user.update({
            where: { id },
            data: { emailVerified: true },
          });
          await tx.platformAuditEvent.create({
            data: {
              actorKind: "user",
              userId: id,
              action: "account.email_verified",
            },
          });
          return id;
        })
      : null;
    if (!userId) {
      return privateJson(
        {
          error: "This link is invalid or has expired.",
          code: "token_invalid",
        },
        { status: 400 },
      );
    }
    return privateJson({ status: "verified" });
  });
}

/** POST /api/account/verification/resend: public, always the same 202. */
export function resendVerification(deps: AccountDependencies) {
  return publicRoute(deps, async (request) => {
    const db = deps.db();
    const ip = clientIp(request.headers);
    if (await over(db, `verify:resend:ip:${ip ?? "unknown"}`, 3600, 10)) {
      return tooMany(3600);
    }
    const parsed = Resend.safeParse(await body(request));
    if (!parsed.success) return invalid(parsed.error);
    if (
      !(await deps.verifyTurnstile(parsed.data.turnstileToken, "resend", ip))
    ) {
      return privateJson(
        {
          error: "We couldn't confirm you're not a robot. Try again.",
          code: "turnstile_failed",
        },
        { status: 400 },
      );
    }
    const user = await db.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true, email: true, emailVerified: true },
    });
    if (
      user &&
      !user.emailVerified &&
      (await resendWait(db, user.id)) === null
    ) {
      await sendVerification(deps, user);
      deps.dispatch();
    }
    return checkEmail();
  });
}

/** POST /api/account/verification/resend-mine: the signed-in, unverified user. */
export function resendMine(deps: AccountDependencies) {
  return publicRoute(deps, async (request) => {
    const session = await deps
      .auth()
      .api.getSession({ headers: request.headers });
    if (!session) throw new HttpError(401, "Sign in to continue");
    const db = deps.db();
    const user = await db.user.findUniqueOrThrow({
      where: { id: session.user.id },
      select: { id: true, email: true, emailVerified: true },
    });
    if (user.emailVerified) {
      return privateJson({ status: "already-verified" });
    }
    const wait = await resendWait(db, user.id);
    if (wait !== null) return tooMany(wait);
    await sendVerification(deps, user);
    deps.dispatch();
    return privateJson({ status: "sent" }, { status: 202 });
  });
}
