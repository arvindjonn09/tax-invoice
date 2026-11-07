const dateTime = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Australia/Sydney",
});

/** "3 Dec 2026, 9:14 am" in Sydney time (design §12). */
export const sydneyDateTime = (iso: string) =>
  dateTime
    .format(new Date(iso))
    .replace(/\s?([AP]M)$/i, (_, m: string) => ` ${m.toLowerCase()}`);

/** The wait after a 429: "N hours", or the day once it's over 48 hours. */
export function waitText(retryAfterSeconds: number, now = new Date()) {
  if (retryAfterSeconds > 48 * 3600) {
    const day = new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Australia/Sydney",
    }).format(new Date(now.getTime() + retryAfterSeconds * 1000));
    return `on ${day}`;
  }
  const hours = Math.max(1, Math.ceil(retryAfterSeconds / 3600));
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}
