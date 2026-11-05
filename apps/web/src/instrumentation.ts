/**
 * Runs once when a Next.js server instance starts. #259: start the email
 * outbox sweep in the Node.js runtime (never on the edge).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { sweepEnabled, startEmailSweep } =
    await import("./server/email/sweep");
  if (!sweepEnabled()) return;
  const { sweepOutbox } = await import("./server/email");
  startEmailSweep(sweepOutbox);
}
