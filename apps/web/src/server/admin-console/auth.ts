import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Owner admin console (#252). Credentials live in a gitignored `.env-admin`
 * file, re-read on every login so the owner can change them without a
 * restart. Without a username, password and secret the console is off.
 */
export type AdminConfig = {
  username: string;
  password: string;
  secret: string;
  updatesFile: string | null;
};

export const ADMIN_COOKIE = "jobflow_admin";
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

/** `KEY=value` lines; `#` comments; optional matching quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[match[1]!] = value;
  }
  return values;
}

/** ADMIN_ENV_FILE, else `.env-admin` at the repository root or the cwd. */
export function adminEnvPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): string | null {
  const candidates = [
    env.ADMIN_ENV_FILE,
    resolve(cwd, "../../.env-admin"),
    resolve(cwd, ".env-admin"),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function loadAdminConfig(path = adminEnvPath()): AdminConfig | null {
  if (!path) return null;
  const values = parseEnvFile(readFileSync(path, "utf8"));
  const username = values.ADMIN_CONSOLE_USERNAME ?? "";
  const password = values.ADMIN_CONSOLE_PASSWORD ?? "";
  const secret = values.ADMIN_CONSOLE_SECRET ?? "";
  // Off unless all three are set and strong enough.
  if (!username || password.length < 12 || secret.length < 32) return null;
  return {
    username,
    password,
    secret,
    updatesFile: values.AGENT_UPDATES_FILE || null,
  };
}

function equal(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right);
}

const COMPARE_SALT = randomBytes(16);

function slowHash(value: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(value, COMPARE_SALT, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/**
 * Constant-time check of both fields (no early exit on the username). The
 * password hash is slow, and off the main thread so login attempts can't
 * stall the app; the salt lives only in this process.
 */
export async function credentialsMatch(
  config: AdminConfig,
  username: string,
  password: string,
): Promise<boolean> {
  const user = equal(config.username, username);
  const [expected, given] = await Promise.all([
    slowHash(config.password),
    slowHash(password),
  ]);
  return timingSafeEqual(expected, given) && user;
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** `<base64url payload>.<hmac>`; the payload holds the username and expiry. */
export function createSessionToken(
  config: AdminConfig,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      u: config.username,
      exp: Math.floor(now / 1000) + ADMIN_SESSION_SECONDS,
    }),
  ).toString("base64url");
  return `${payload}.${sign(config.secret, payload)}`;
}

/**
 * Valid only while signed with the current secret, unexpired and for the
 * current username, so changing any of them in `.env-admin` signs everyone out.
 */
export function verifySessionToken(
  config: AdminConfig,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token || token.length > 512) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!equal(sign(config.secret, payload), signature)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      u?: unknown;
      exp?: unknown;
    };
    return (
      data.u === config.username &&
      typeof data.exp === "number" &&
      data.exp > Math.floor(now / 1000)
    );
  } catch {
    return false;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_SESSION_SECONDS}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function readCookie(
  header: string | null,
  name: string,
): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
