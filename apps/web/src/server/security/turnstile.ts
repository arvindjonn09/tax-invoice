import { log } from "../log";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Turnstile is enforced once TURNSTILE_SECRET_KEY is configured (#213). */
export function turnstileEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY);
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
    ip,
    fetcher = fetch,
  }: {
    env?: Readonly<Record<string, string | undefined>>;
    production: boolean;
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
    };
    return result.success === true && result.action === action;
  } catch (error) {
    log("warn", "security.turnstile_unavailable", {
      error: error instanceof Error ? error.name : "Error",
    });
    return false;
  }
}
