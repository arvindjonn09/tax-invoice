/**
 * Route gating (S1, #223). Pages are deny-by-default: every page outside
 * this allowlist needs a session, so the proxy sends a request with no
 * session cookie to `/login?next=<path>`. Layouts still resolve the actor on
 * every request (a cookie isn't a session). API routes are not gated here:
 * each handler is deny-by-default itself (`withPolicy`), and the public ones
 * are listed in docs/security/route-matrix.md.
 *
 * Kept free of server imports: the proxy loads it on every request.
 */

/** Pages anyone may open (S1 AC6). Exact paths. */
export const PUBLIC_PAGES: readonly string[] = [
  "/",
  "/login",
  "/signup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/terms",
  "/privacy",
];

/** Design pages: public outside production only (S1 AC7). */
export const DESIGN_PAGES: readonly string[] = [
  "/design-system",
  "/design-previews",
];

/** The same rule as isProductionEnvironment (server/auth/config). */
function production(env: Readonly<Record<string, string | undefined>>) {
  return env.APP_ENV
    ? env.APP_ENV === "production"
    : env.NODE_ENV === "production";
}

const under = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/** Whether a page path may be opened without a session. */
export function isPublicPage(
  pathname: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (PUBLIC_PAGES.includes(path)) return true;
  if (!production(env) && DESIGN_PAGES.some((base) => under(path, base)))
    return true;
  return false;
}

/** Paths the page gate leaves alone: API handlers gate themselves. */
export function isApiPath(pathname: string): boolean {
  return under(pathname, "/api");
}

/** Better Auth's session cookie (cookiePrefix "jobflow"), plain or __Secure-. */
export const SESSION_COOKIES = [
  "jobflow.session_token",
  "__Secure-jobflow.session_token",
] as const;

/** The proxy passes the requested path to layouts in this header. */
export const PATH_HEADER = "x-jobflow-path";
