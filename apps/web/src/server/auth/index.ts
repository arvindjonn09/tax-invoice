import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { createDatabaseClient } from "../../../../../packages/database/src/index";
import { type Auth, createAuth } from "./config";

export { createAuth, type Auth } from "./config";
export { createCredentialUser } from "./credentials";
export { resolveActor, setActiveCompany, type Actor } from "./actor";

let database: PrismaClient | undefined;
let auth: Auth | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/** One database client per server process. */
export function getDatabase(): PrismaClient {
  database ??= createDatabaseClient(required("DATABASE_URL"));
  return database;
}

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

/** Lazily created so `next build` needs no secrets. */
export function getAuth(): Auth {
  auth ??= createAuth({
    db: getDatabase(),
    secret: required("BETTER_AUTH_SECRET"),
    baseURL: required("BETTER_AUTH_URL"),
    production: isProductionEnvironment(process.env),
  });
  return auth;
}

/**
 * The app's own origin: the only one allowed to send mutations (#71).
 * Unconfigured means none — every mutation is refused (fail closed).
 */
export function getTrustedOrigins(): string[] {
  const url = process.env.BETTER_AUTH_URL;
  return url ? [new URL(url).origin] : [];
}
