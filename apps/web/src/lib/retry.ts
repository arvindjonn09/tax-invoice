/**
 * The throttled message (docs/design/signup-trial.md, Forms): the wait the
 * server sends, rounded up to whole minutes, or hours from 90 minutes up.
 */
export function waitText(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= 90 * 60) {
    const hours = Math.ceil(seconds / 3600);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** "Too many attempts. You can try again in 4 minutes." */
export function throttledText(seconds: number | null | undefined): string {
  const wait = waitText(seconds);
  return wait
    ? `Too many attempts. You can try again in ${wait}.`
    : "Too many attempts. Try again in a few minutes.";
}

/** The wait from a 429: `retryAfterSeconds` in the body, else Retry-After. */
export function retryAfter(
  response: Response,
  body: object | null,
): number | null {
  const fromBody = Number(
    (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds,
  );
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const header = Number(
    response.headers.get("retry-after") ??
      response.headers.get("x-retry-after"),
  );
  return Number.isFinite(header) && header > 0 ? header : null;
}
