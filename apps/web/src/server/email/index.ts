import { after } from "next/server";
import { getDatabase, isProductionEnvironment } from "../auth";
import { log, safeError } from "../log";
import { dispatchOutbox } from "./outbox";
import { type EmailTransport, transportFromEnv } from "./transport";

export { enqueueEmail, cancelPendingEmail, dispatchOutbox } from "./outbox";
export { addressDigest } from "./crypto";
export type { EmailMessage, EmailTransport } from "./transport";

let transport: EmailTransport | undefined;

/** Secret for outbox encryption and address digests (32+ characters). */
export function emailSecret(): string {
  const secret = process.env.EMAIL_OUTBOX_KEY;
  if (!secret) throw new Error("EMAIL_OUTBOX_KEY is not configured");
  return secret;
}

export function getEmailTransport(): EmailTransport {
  transport ??= transportFromEnv(
    process.env,
    isProductionEnvironment(process.env),
  );
  return transport;
}

/** Tests swap in a MemoryTransport. */
export function setEmailTransport(next: EmailTransport | undefined): void {
  transport = next;
}

/** Support and reply address shown to users (ADR 0004 D7). */
export { supportEmail } from "./addresses";

/**
 * Send queued email after the response is sent ("within 60 s"). Failures stay
 * queued for the retry sweep; they never fail the request.
 */
export function dispatchSoon(): void {
  after(async () => {
    try {
      await dispatchOutbox(getDatabase(), getEmailTransport(), emailSecret());
    } catch (error) {
      log("error", "email.dispatch_failed", { error: safeError(error) });
    }
  });
}
