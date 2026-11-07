import { type NextRequest, NextResponse } from "next/server";
import {
  PATH_HEADER,
  SESSION_COOKIES,
  isApiPath,
  isPublicPage,
} from "@/server/routes/public";
import { loginFor } from "@/server/routes/safe-next";
import { createNonce, securityHeaders } from "@/server/security/headers";

/** The only pages allowed to frame Cloudflare's challenge. */
const TURNSTILE_PAGES = new Set(["/signup", "/verify-email"]);

/**
 * Security headers and a per-request CSP nonce for every page and API
 * response (#71). Next.js reads the nonce from the request's CSP header and
 * applies it to its own scripts, so pages must render dynamically (the root
 * layout reads headers()).
 *
 * Pages outside the public allowlist need a session (S1, #223): with no
 * session cookie the request goes to `/login?next=<path>`. A cookie alone
 * proves nothing; layouts resolve the actor on every request.
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const headers = securityHeaders({
    nonce,
    development: process.env.NODE_ENV === "development",
    https:
      request.nextUrl.protocol === "https:" ||
      (process.env.BETTER_AUTH_URL ?? "").startsWith("https:"),
    turnstile:
      Boolean(process.env.TURNSTILE_SITE_KEY) &&
      TURNSTILE_PAGES.has(request.nextUrl.pathname),
  });
  const { pathname, search } = request.nextUrl;
  const page = !isApiPath(pathname);
  const gated = page && !isPublicPage(pathname);
  if (gated && !SESSION_COOKIES.some((name) => request.cookies.has(name))) {
    const target = new URL(loginFor(`${pathname}${search}`), request.url);
    // 303 so a form POST arrives at sign-in as a GET.
    const redirect = NextResponse.redirect(
      target,
      request.method === "GET" || request.method === "HEAD" ? 307 : 303,
    );
    for (const [name, value] of Object.entries(headers))
      redirect.headers.set(name, value);
    redirect.headers.set("Cache-Control", "private, no-store");
    return redirect;
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Layouts send a stale session back to sign-in with this path as `next`.
  requestHeaders.set(PATH_HEADER, `${pathname}${search}`);
  requestHeaders.set(
    "Content-Security-Policy",
    headers["Content-Security-Policy"] ?? "",
  );
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  // Signed-in pages are force-dynamic, so Next.js itself sends
  // "private, no-cache, no-store, …" for them (S1 AC8; see route-gating test).
  return response;
}

export const config = {
  // Build output with hashed names needs no nonce; everything else gets headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
