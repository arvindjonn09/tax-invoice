import { log, safeError } from "../log";

// #259: a timer that dispatches the outbox every minute, so email held back
// by the hourly cap, a provider pause or a retry delay goes out without
// waiting for some later request to call dispatchSoon(). Several processes
// may each run one; claims are serialised by the outbox's advisory lock.

export const SWEEP_INTERVAL_MS = 60_000;

type Sweep = () => Promise<unknown>;

const state = globalThis as typeof globalThis & {
  __jobflowEmailSweep?: ReturnType<typeof setInterval> | undefined;
};

/**
 * Production builds sweep by default; `EMAIL_SWEEP=off` turns it off (for
 * a host where another process sweeps) and `EMAIL_SWEEP=on` turns it on in
 * development.
 */
export function sweepEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const setting = env.EMAIL_SWEEP?.trim().toLowerCase();
  if (setting === "off") return false;
  if (setting === "on") return true;
  return env.NODE_ENV === "production";
}

/** Start the timer once per process. Returns a stop function (tests). */
export function startEmailSweep(
  sweep: Sweep,
  intervalMs = SWEEP_INTERVAL_MS,
): () => void {
  if (state.__jobflowEmailSweep) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow sweep is never overlapped by the next
    running = true;
    sweep()
      .catch((error: unknown) =>
        log("error", "email.sweep_failed", { error: safeError(error) }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  state.__jobflowEmailSweep = timer;
  return () => {
    clearInterval(timer);
    state.__jobflowEmailSweep = undefined;
  };
}
