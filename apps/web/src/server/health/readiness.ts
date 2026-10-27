/** Share one short-lived readiness result across concurrent probes. */
export function cachedReadiness(
  probe: () => Promise<boolean>,
  ttlMs = 2000,
  now = () => Date.now(),
) {
  let cached: { value: boolean; until: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  return () => {
    if (cached && now() < cached.until) return Promise.resolve(cached.value);
    inFlight ??= probe()
      .catch(() => false)
      .then((value) => {
        cached = { value, until: now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
