import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** 10 MiB: large phone photos and scanned invoices fit; anything bigger is refused. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * The real type from the file's first bytes. The client's declared type and
 * file extension are never trusted; anything else (HTML, SVG, scripts,
 * archives, office files) is refused.
 */
export function sniffType(bytes: Uint8Array): AllowedType | null {
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-")
    return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4, 8) === "ftyp" &&
    ["heic", "heix", "mif1", "msf1"].includes(ascii(bytes, 8, 12))
  )
    return "image/heic";
  return null;
}

const EXTENSION: Record<AllowedType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

/**
 * A safe display name: no path parts, control or unusual characters, at most
 * 100 characters, and the extension of the real (sniffed) type.
 */
export function safeFileName(original: string, type: AllowedType): string {
  const base =
    (original.split(/[\\/]/).pop() ?? "")
      .replace(/\.[^.]*$/, "")
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N} ._()-]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "document";
  return `${base}.${EXTENSION[type]}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Short-lived download links: 5 minutes. */
export const LINK_TTL_SECONDS = 5 * 60;

export type LinkClaims = { documentId: string; companyId: string; exp: number };

/** A key just for file links, derived from the app secret (never reused raw). */
function linkKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, "jobflow", "file-download-links", 32),
  );
}

/** `<claims>.<hmac>`, both base64url. Bound to one document and company. */
export function signLink(claims: LinkClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", linkKey(secret))
    .update(body)
    .digest("base64url");
  return `${body}.${mac}`;
}

export type LinkCheck =
  | { ok: true; claims: LinkClaims }
  | { ok: false; reason: "invalid" | "expired" };

export function verifyLink(
  token: string,
  secret: string,
  now = Date.now(),
): LinkCheck {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined)
    return { ok: false, reason: "invalid" };
  const expected = createHmac("sha256", linkKey(secret)).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "invalid" };
  let claims: LinkClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    typeof claims?.documentId !== "string" ||
    typeof claims.companyId !== "string" ||
    typeof claims.exp !== "number"
  )
    return { ok: false, reason: "invalid" };
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
