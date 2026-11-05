import { isIP } from "node:net";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { HttpError } from "./guards";

export type ThrottleRule = { windowSeconds: number; max: number };

/**
 * Limits for expensive actions (docs/security/requirements.md). Each is
 * applied per actor AND per client IP, so neither a shared office IP nor one
 * account can exhaust it alone. Sign-in throttling lives in Better Auth (#13).
 */
export const THROTTLES = {
  export: { windowSeconds: 60, max: 5 },
  pdf: { windowSeconds: 60, max: 20 },
  "document.upload": { windowSeconds: 60, max: 30 },
  "download.sign": { windowSeconds: 60, max: 60 },
} as const satisfies Record<string, ThrottleRule>;

export type ThrottledAction = keyof typeof THROTTLES;

/**
 * Count one hit for `key` in a fixed window, atomically in the shared
 * database (safe across server instances), and return the count so far.
 * Stored beside Better Auth's sign-in counters under a `jobflow:` prefix.
 */
export async function hit(
  db: PrismaClient,
  key: string,
  { windowSeconds }: ThrottleRule,
  now = Date.now(),
): Promise<number> {
  const windowStart = BigInt(now - windowSeconds * 1000);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO auth_rate_limits (key, count, last_request)
    VALUES (${`jobflow:${key}`}, 1, ${BigInt(now)})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN auth_rate_limits.last_request < ${windowStart}
                   THEN 1 ELSE auth_rate_limits.count + 1 END,
      last_request = CASE WHEN auth_rate_limits.last_request < ${windowStart}
                          THEN EXCLUDED.last_request
                          ELSE auth_rate_limits.last_request END
    RETURNING count`;
  return rows[0]?.count ?? 1;
}

/** Throw 429 once the actor or the IP is over the action's limit. */
export async function throttle(
  db: PrismaClient,
  action: ThrottledAction,
  { userId, ip }: { userId: string; ip: string | null },
): Promise<void> {
  const rule = THROTTLES[action];
  const counts = await Promise.all([
    hit(db, `${action}:user:${userId}`, rule),
    ...(ip ? [hit(db, `${action}:ip:${ip}`, rule)] : []),
  ]);
  if (counts.some((count) => count > rule.max)) {
    throw new HttpError(429, "Too many requests. Wait a minute and try again.");
  }
}

/**
 * The client's address for throttling. CLIENT_IP_HEADER names the one header
 * the trusted proxy sets (`cf-connecting-ip` behind a Cloudflare Tunnel, where
 * X-Forwarded-For keeps whatever the client sent). Without it, the first
 * X-Forwarded-For hop, which nginx overwrites (#64). Anything that isn't an IP
 * address is ignored, so it can't create arbitrary throttle keys.
 */
export function clientIp(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env.CLIENT_IP_HEADER
    ? headers.get(env.CLIENT_IP_HEADER)
    : headers.get("x-forwarded-for")?.split(",")[0] || headers.get("x-real-ip");
  const ip = raw?.trim();
  return ip && isIP(ip) ? ip : null;
}
