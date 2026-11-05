import { log } from "../log";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Public key for the widget. Set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY
 * together: a secret without the widget refuses every submission.
 */
export function turnstileSiteKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return env.TURNSTILE_SITE_KEY || null;
}

/**
 * Verify a Cloudflare Turnstile token on the server (S2 AC8). Without a
 * secret configured the check is skipped outside production; production
 * without a secret fails closed. Errors fail closed too.
 */
export async function verifyTurnstile(
  token: string | undefined,
  action: string,
  {
    env = process.env,
    production,
    hostname,
    ip,
    fetcher = fetch,
  }: {
    env?: Readonly<Record<string, string | undefined>>;
    production: boolean;
    /** The app's own hostname; a token solved on another site is refused. */
    hostname: string;
    ip?: string | null;
    fetcher?: Fetch;
  },
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return !production;
  if (!token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const response = await fetcher(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body, signal: AbortSignal.timeout(5000) },
    );
    const result = (await response.json()) as {
      success?: boolean;
      action?: string;
      hostname?: string;
    };
    return (
      result.success === true &&
      result.action === action &&
      result.hostname === hostname
    );
  } catch (error) {
    log("warn", "security.turnstile_unavailable", {
      error: error instanceof Error ? error.name : "Error",
    });
    return false;
  }
}
