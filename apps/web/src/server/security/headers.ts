/**
 * Response security headers (docs/security/requirements.md, #71).
 * Applied to every page and API response by src/proxy.ts.
 */

export type HeaderOptions = {
  /** Fresh per request; lets Next.js and next-themes inline scripts run. */
  nonce: string;
  /** `next dev` needs eval for React's debugging stack traces. */
  development: boolean;
  /** Served over HTTPS: upgrade subresources and send HSTS. */
  https: boolean;
};

/** Two years; no `preload` until the production domain is final (#64). */
export const HSTS = "max-age=63072000; includeSubDomains";

export function contentSecurityPolicy({
  nonce,
  development,
  https,
}: HeaderOptions): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    // `next dev` injects un-nonced <style> tags for hot reload; production
    // serves CSS files, and Next.js nonces its own inline styles.
    development
      ? "style-src 'self' 'unsafe-inline'"
      : `style-src 'self' 'nonce-${nonce}'`,
    // Inline style ATTRIBUTES (no script); some UI primitives position with them.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

export function securityHeaders(
  options: HeaderOptions,
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(options),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    // Full URLs (which may carry ids or signed parameters) never leave the origin.
    "Referrer-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(options.https ? { "Strict-Transport-Security": HSTS } : {}),
  };
}

/** 128 random bits, base64 — unpredictable and unique per request. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
