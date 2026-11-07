import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { verifyPassword } from "better-auth/crypto";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { log } from "../log";
import {
  ENROLMENT_CODE_HEADER,
  consumeEnrolmentCode,
  hasEnrolmentCode,
  isOperator,
} from "../operator/access";

export const SESSION_TTL_SECONDS = 60 * 60 * 12;
export const SIGN_IN_WINDOW_SECONDS = 60;
export const SIGN_IN_MAX_ATTEMPTS = 5;
export const MIN_PASSWORD_LENGTH = 12;
/** Synthetic demo identities (#21) use the reserved `.test` TLD. */
export const DEMO_EMAIL = /@example\.test$/i;

/**
 * The real production environment. `next start` always sets NODE_ENV=production,
 * so staging and previews declare themselves with APP_ENV (staging, preview,
 * development); without APP_ENV a production build counts as production.
 */
export function isProductionEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.APP_ENV
    ? env.APP_ENV === "production"
    : env.NODE_ENV === "production";
}

export type AuthSettings = {
  db: PrismaClient;
  /** At least 32 random characters; never committed (BETTER_AUTH_SECRET). */
  secret: string;
  /** Public origin of the app, e.g. https://jobflow.example.com (BETTER_AUTH_URL). HTTPS ⇒ Secure cookies. */
  baseURL: string;
  /** The real production environment: refuses demo accounts, forces Secure cookies. */
  production: boolean;
  /** The trusted proxy's client-IP header for sign-in throttling (CLIENT_IP_HEADER). */
  clientIpHeader?: string | undefined;
};

/**
 * Email + password sign-in with database sessions (ADR 0003).
 * - Better Auth's own sign-up stays disabled: public sign-up, verification
 *   and reset are JobFlow handlers (ADR 0004 D1, server/account).
 * - Sessions live in `auth_sessions`, so they can be revoked by deleting rows.
 * - Cookies are HttpOnly, SameSite=Lax and Secure in production.
 * - POSTs are rejected unless their Origin is the app's own (CSRF).
 * - Sign-in is throttled per client IP in the shared database.
 */
const MFA_FACTORS: Readonly<Record<string, string>> = {
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
};

export function createAuth(settings: AuthSettings) {
  if (settings.secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  const { db, production } = settings;
  // Secure cookies whenever the app is served over HTTPS, and always in production.
  const secureCookies =
    production || new URL(settings.baseURL).protocol === "https:";
  return betterAuth({
    appName: "JobFlow",
    secret: settings.secret,
    baseURL: settings.baseURL,
    trustedOrigins: [new URL(settings.baseURL).origin],
    database: prismaAdapter(db, { provider: "postgresql" }),
    telemetry: { enabled: false },
    // Errors only, through the redacting logger (#71).
    logger: {
      level: "error",
      log: (level, message, ...args) =>
        log(level === "debug" ? "info" : level, "auth", { message, args }),
    },
    // A lost device goes through `pnpm operator enrol-code --reset`, so a stolen
    // session and password can't remove or copy TOTP. Enrolment shows the secret
    // and backup codes once. Reset and verification run through /api/account/*
    // (#218, #219), which add throttles, Turnstile and single-use tokens these
    // endpoints don't have.
    disabledPaths: [
      "/two-factor/disable",
      "/two-factor/get-totp-uri",
      "/two-factor/generate-backup-codes",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/verify-email",
    ],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: 128,
    },
    user: { modelName: "user" },
    account: { modelName: "authAccount" },
    verification: { modelName: "authVerification" },
    session: {
      modelName: "authSession",
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 60,
      additionalFields: {
        activeCompanyId: { type: "string", required: false, input: false },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "authRateLimit",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": {
          window: SIGN_IN_WINDOW_SECONDS,
          max: SIGN_IN_MAX_ATTEMPTS,
        },
      },
    },
    advanced: {
      // Better Auth skips these checks when NODE_ENV=test; pin them on everywhere.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ...(settings.clientIpHeader
        ? { ipAddress: { ipAddressHeaders: [settings.clientIpHeader] } }
        : {}),
      cookiePrefix: "jobflow",
      useSecureCookies: secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: secureCookies,
        path: "/",
      },
      database: { generateId: "uuid" },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // Accounts whose company access was deactivated cannot establish
            // new sessions. Never-member accounts can sign in to accept an invite.
            const memberships = await db.membership.findMany({
              where: { userId: session.userId },
              select: { isActive: true },
            });
            if (
              memberships.length > 0 &&
              !memberships.some((m) => m.isActive)
            ) {
              throw new APIError("FORBIDDEN", {
                message: "Account access is inactive",
              });
            }
            if (!production) return;
            const user = await db.user.findUnique({
              where: { id: session.userId },
              select: { email: true },
            });
            if (!user || DEMO_EMAIL.test(user.email)) {
              throw new APIError("FORBIDDEN", {
                message: "Demo accounts cannot sign in to production",
              });
            }
          },
        },
      },
    },
    hooks: {
      // ADR 0004 D5: TOTP is for platform operators only. Anyone else gets the
      // same 404 as a path that doesn't exist.
      before: createAuthMiddleware(async (ctx) => {
        if (!ctx.path.startsWith("/two-factor/")) return;
        // Trust-device stays off: a trusted device would skip TOTP for 30 days.
        if ((ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice) {
          throw new APIError("BAD_REQUEST", {
            message: "Trusted devices aren't available",
          });
        }
        const session = await getSessionFromCtx(ctx);
        // Mid sign-in there's no session yet, and only an enrolled user gets
        // this far: the plugin checks its own short-lived cookie.
        if (!session && ctx.path.startsWith("/two-factor/verify-")) return;
        const allowed =
          session &&
          (await isOperator(db, session.user.id, {
            env: process.env,
            production: false,
          }));
        if (!allowed) throw new APIError("NOT_FOUND");
        if (ctx.path !== "/two-factor/enable") return;
        // Order matters (#346). The code is checked first, so nobody without
        // one can test passwords here; then the password, because the plugin
        // only checks it after this hook and a typo mustn't spend the code;
        // then the code is spent, atomically, in case of a race.
        const refused = () =>
          new APIError("FORBIDDEN", {
            message: "Enter a valid enrolment code",
          });
        const code = ctx.headers?.get(ENROLMENT_CODE_HEADER);
        if (!code || !(await hasEnrolmentCode(db, session.user.id, code)))
          throw refused();
        const password = (ctx.body as { password?: unknown } | undefined)
          ?.password;
        const account = await db.authAccount.findFirst({
          where: { userId: session.user.id, providerId: "credential" },
          select: { password: true },
        });
        if (
          typeof password !== "string" ||
          !account?.password ||
          !(await verifyPassword({ hash: account.password, password }))
        ) {
          throw new APIError("BAD_REQUEST", {
            code: "INVALID_PASSWORD",
            message: "Invalid password",
          });
        }
        if (!(await consumeEnrolmentCode(db, session.user.id, code)))
          throw refused();
        await db.platformAuditEvent.create({
          data: {
            actorKind: "user",
            userId: session.user.id,
            action: "operator.enrolment_code_consumed",
          },
        });
      }),
      // TOTP belongs to the session that passed it (ADR 0004 D5, T21). A failed
      // check returns an error with no token, so nothing is recorded.
      after: createAuthMiddleware(async (ctx) => {
        const factor = MFA_FACTORS[ctx.path];
        if (!factor) return;
        const returned = (
          ctx.context.returned as { token?: unknown } | undefined
        )?.token;
        if (typeof returned !== "string") return;
        // Confirming enrolment replaces the session but returns the old token.
        const token = ctx.context.newSession?.session.token ?? returned;
        await db.$transaction(async (tx) => {
          const { userId } = await tx.authSession.update({
            where: { token },
            data: { mfaVerifiedAt: new Date() },
            select: { userId: true },
          });
          await tx.platformAuditEvent.create({
            data: {
              actorKind: "user",
              userId,
              action: "operator.mfa_verified",
              metadata: { factor },
            },
          });
        });
      }),
    },
    plugins: [twoFactor({ issuer: "JobFlow" }), nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
