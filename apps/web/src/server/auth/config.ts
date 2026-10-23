import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";

export const SESSION_TTL_SECONDS = 60 * 60 * 12;
export const SIGN_IN_WINDOW_SECONDS = 60;
export const SIGN_IN_MAX_ATTEMPTS = 5;
export const MIN_PASSWORD_LENGTH = 12;
/** Synthetic demo identities (#21) use the reserved `.test` TLD. */
export const DEMO_EMAIL = /@example\.test$/i;

export type AuthSettings = {
  db: PrismaClient;
  /** At least 32 random characters; never committed (BETTER_AUTH_SECRET). */
  secret: string;
  /** Public origin of the app, e.g. https://jobflow.example.com (BETTER_AUTH_URL). HTTPS ⇒ Secure cookies. */
  baseURL: string;
  /** The real production environment: refuses demo accounts, forces Secure cookies. */
  production: boolean;
};

/**
 * Email + password sign-in with database sessions (ADR 0003).
 * - No public sign-up: users are created by owners (#27) or seeding (#21).
 * - Sessions live in `auth_sessions`, so they can be revoked by deleting rows.
 * - Cookies are HttpOnly, SameSite=Lax and Secure in production.
 * - POSTs are rejected unless their Origin is the app's own (CSRF).
 * - Sign-in is throttled per client IP in the shared database.
 */
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
    // Errors only; Better Auth never logs passwords or session tokens.
    logger: { level: "error" },
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
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
