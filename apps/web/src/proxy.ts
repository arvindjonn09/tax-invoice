import { type NextRequest, NextResponse } from "next/server";
import { createNonce, securityHeaders } from "@/server/security/headers";

/**
 * Security headers and a per-request CSP nonce for every page and API
 * response (#71). Next.js reads the nonce from the request's CSP header and
 * applies it to its own scripts, so pages must render dynamically (the root
 * layout reads headers()).
 */
export function proxy(request: NextRequest) {
  const nonce = createNonce();
  const headers = securityHeaders({
    nonce,
    development: process.env.NODE_ENV === "development",
    https:
      request.nextUrl.protocol === "https:" ||
      (process.env.BETTER_AUTH_URL ?? "").startsWith("https:"),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(
    "Content-Security-Policy",
    headers["Content-Security-Policy"] ?? "",
  );
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  // Build output with hashed names needs no nonce; everything else gets headers.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
