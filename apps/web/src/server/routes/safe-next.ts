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

/** Dot segments removed, it still stays on this origin as a path. */
function normalisesSafely(value: string): boolean {
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE && !url.pathname.startsWith("//");
  } catch {
    return false;
  }
}

function looksSafe(value: string): boolean {
  return (
    normalisesSafely(value) &&
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
  if (!looksSafe(raw)) return HOME;
  // Check every decoding of the path, so an encoded `//` or `\` can't slip
  // through. The query and fragment are data: they can't change where the
  // browser goes, and encoded values like `?q=Sample%20Customer` must survive.
  const pathEnd = raw.search(/[?#]/);
  let value = pathEnd < 0 ? raw : raw.slice(0, pathEnd);
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
  // Check the normalised result too: dot segments ("/.//evil.example",
  // "/foo/..//evil.example") collapse into a protocol-relative "//…".
  const result = `${url.pathname}${url.search}${url.hash}`;
  return looksSafe(result) ? result : HOME;
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
