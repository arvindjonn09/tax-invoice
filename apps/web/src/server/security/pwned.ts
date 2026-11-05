import { createHash } from "node:crypto";
import { log } from "../log";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Has this password appeared in a known breach? Uses the Pwned Passwords
 * k-anonymity range API: only the first 5 hex characters of the SHA-1 hash
 * leave the server, never the password or its full hash (S2 AC3). Fails
 * open: an outage or timeout returns false and is logged.
 */
export async function isBreachedPassword(
  password: string,
  fetcher: Fetch = fetch,
  timeoutMs = 3000,
): Promise<boolean> {
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const response = await fetcher(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        headers: { "Add-Padding": "true", "User-Agent": "JobFlow" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = await response.text();
    return body.split("\n").some((line) => {
      const [candidate, count] = line.trim().split(":");
      return candidate === suffix && Number(count) > 0;
    });
  } catch (error) {
    log("warn", "security.breach_check_unavailable", {
      error: error instanceof Error ? error.name : "Error",
    });
    return false;
  }
}
