/**
 * A sign-in return target (S1 AC2, #223): only a relative path on this
 * origin. Anything else (protocol-relative `//evil.example`, `/\evil`,
 * absolute URLs, `javascript:`, control characters, or the same hidden by
 * percent-encoding) falls back to `/home`. Sign-in pages are never a target,
 * so a return can't loop.
 */
export const HOME = "/home";
const BASE = "https://jobflow.invalid";
const NEVER = ["/login", "/signup"];

function looksSafe(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    // C0 controls, DEL, and whitespace a browser may strip before parsing.
    !/[\u0000-\u001f\u007f\s]/.test(value)
  );
}

export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000)
    return HOME;
  // Check every decoding of it, so an encoded `//` or `\` can't slip through.
  let value = raw;
  for (let round = 0; round < 4; round += 1) {
    if (!looksSafe(value)) return HOME;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return HOME;
    }
    if (decoded === value) break;
    value = decoded;
  }
  if (!looksSafe(value)) return HOME;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return HOME;
  }
  if (url.origin !== BASE) return HOME;
  if (
    NEVER.some(
      (page) => url.pathname === page || url.pathname.startsWith(`${page}/`),
    )
  )
    return HOME;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `<page>?next=…` for the given path, sanitised; bare `<page>` for home. */
function withNext(page: string, path: string | null | undefined): string {
  const next = safeNextPath(path);
  return next === HOME ? page : `${page}?next=${encodeURIComponent(next)}`;
}

/** Sign in, then come back to `path`. */
export const loginFor = (path: string | null | undefined) =>
  withNext("/login", path);

/** Choose a company, then go on to `path`. */
export const chooserFor = (path: string | null | undefined) =>
  withNext("/choose-company", path);
