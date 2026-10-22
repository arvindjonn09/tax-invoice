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

/** Lazily created so `next build` needs no secrets. */
export function getAuth(): Auth {
  auth ??= createAuth({
    db: getDatabase(),
    secret: required("BETTER_AUTH_SECRET"),
    baseURL: required("BETTER_AUTH_URL"),
    production: process.env.NODE_ENV === "production",
  });
  return auth;
}
