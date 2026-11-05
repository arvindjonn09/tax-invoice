import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { EmailMessage } from "./transport";

/**
 * Outbox payloads hold the recipient and any link, so they are encrypted at
 * rest with AES-256-GCM (ADR 0004 D7). The key is derived with HKDF from
 * EMAIL_OUTBOX_KEY; a separate derivation keys the suppression-list HMAC.
 */
const VERSION = 1;

function derive(secret: string, info: string): Buffer {
  if (secret.length < 32) {
    throw new Error("EMAIL_OUTBOX_KEY must be at least 32 characters");
  }
  return Buffer.from(hkdfSync("sha256", secret, "jobflow-email", info, 32));
}

export function encryptPayload(secret: string, message: EmailMessage): Buffer {
  const key = derive(secret, "outbox-payload-v1");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(message), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function decryptPayload(
  secret: string,
  payload: Uint8Array,
): EmailMessage {
  const data = Buffer.from(payload);
  if (data[0] !== VERSION || data.length < 29) {
    throw new Error("Unsupported email payload");
  }
  const key = derive(secret, "outbox-payload-v1");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
  decipher.setAuthTag(data.subarray(13, 29));
  const text = Buffer.concat([
    decipher.update(data.subarray(29)),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(text) as EmailMessage;
}

/** Stable, non-reversible id for an address (suppressions, dedupe keys). */
export function addressDigest(secret: string, address: string): string {
  return createHmac("sha256", derive(secret, "address-digest-v1"))
    .update(address.trim().toLowerCase())
    .digest("hex");
}
