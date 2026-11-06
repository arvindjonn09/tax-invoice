import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import {
  DESIGN_PAGES,
  PUBLIC_PAGES,
  isApiPath,
  isPublicPage,
} from "@/server/routes/public";
import { chooserFor, loginFor, safeNextPath } from "@/server/routes/safe-next";

// #223 (S1): pages are deny-by-default behind sign-in; `next` stays on-site.

describe("public page allowlist", () => {
  it("is exactly the S1 AC6 list", () => {
    expect(PUBLIC_PAGES).toEqual([
      "/",
      "/login",
      "/signup",
      "/verify-email",
      "/forgot-password",
      "/reset-password",
      "/invite",
      "/terms",
      "/privacy",
    ]);
    expect(DESIGN_PAGES).toEqual(["/design-system", "/design-previews"]);
  });

  it.each([
    "/",
    "/login",
    "/login/",
    "/signup",
    "/verify-email",
    "/forgot-password",
    "/reset-password",
    "/invite",
    "/terms",
    "/privacy",
  ])("%s is public", (path) => {
    expect(isPublicPage(path, { APP_ENV: "production" })).toBe(true);
  });

  it.each([
    "/home",
    "/invoices/123",
    "/dashboard",
    "/choose-company",
    "/onboarding",
    "/account",
    "/verify-email/pending",
    "/settings/trial",
    "/loginx",
    "/invite/extra",
    "/operator",
  ])("%s needs a session", (path) => {
    expect(isPublicPage(path, { APP_ENV: "production" })).toBe(false);
  });

  it("design pages are public outside production only (S1 AC7)", () => {
    for (const path of ["/design-system", "/design-previews/dashboard"]) {
      expect(isPublicPage(path, { APP_ENV: "production" })).toBe(false);
      expect(isPublicPage(path, { NODE_ENV: "production" })).toBe(false);
      expect(isPublicPage(path, { APP_ENV: "staging" })).toBe(true);
      expect(isPublicPage(path, { NODE_ENV: "development" })).toBe(true);
    }
  });

  it("API paths are left to their handlers", () => {
    expect(isApiPath("/api/company")).toBe(true);
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
  });
});

describe("safe return path", () => {
  it.each([
    ["/invoices/123", "/invoices/123"],
    ["/jobs?status=open#top", "/jobs?status=open#top"],
    ["/home", "/home"],
    ["/invoices/%E2%9C%93", "/invoices/%E2%9C%93"],
  ])("keeps %s", (raw, expected) => {
    expect(safeNextPath(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "",
    "home",
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "/\\/evil.example",
    "https://evil.example",
    "http://127.0.0.1:3000/home",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "%2F%2Fevil.example",
    "/%2F%2Fevil.example",
    "/%2Fevil.example",
    "%2f%2fevil.example",
    "/%5Cevil.example",
    "/%255C%255Cevil.example",
    "%252F%252Fevil.example",
    "/%2F%252Fevil.example",
    "/\tevil",
    "/\n/evil.example",
    "/%0A/evil.example",
    "/%09/evil.example",
    "/ /evil.example",
    "/%E0%A4%A",
    // Dot segments that normalise to a protocol-relative path (#319 review).
    "/.//evil.example",
    "/foo/..//evil.example",
    "/%2e//evil.example",
    "/%2E%2E//evil.example",
    "/a/b/../..//evil.example",
    "/./%2F/evil.example",
    "/login",
    "/login?next=/home",
    "/signup",
    `/${"a".repeat(2001)}`,
  ])("falls back to /home for %j", (raw) => {
    expect(safeNextPath(raw)).toBe("/home");
  });

  it("builds sign-in and chooser links with an encoded next", () => {
    expect(loginFor("/invoices/123?x=1")).toBe(
      "/login?next=%2Finvoices%2F123%3Fx%3D1",
    );
    expect(loginFor("//evil.example")).toBe("/login");
    expect(loginFor(null)).toBe("/login");
    expect(chooserFor("/jobs")).toBe("/choose-company?next=%2Fjobs");
    expect(chooserFor("/home")).toBe("/choose-company");
  });
});

describe("proxy gate", () => {
  /** Same-origin redirect target, path and query. */
  const where = (response: Response) => {
    const url = new URL(response.headers.get("location")!);
    return `${url.pathname}${url.search}`;
  };
  const request = (
    path: string,
    init: { cookie?: string; method?: string } = {},
  ) =>
    new NextRequest(`http://127.0.0.1:3000${path}`, {
      method: init.method ?? "GET",
      headers: init.cookie ? { cookie: init.cookie } : {},
    });

  it("sends a signed-out deep link to sign-in with next", () => {
    const response = proxy(request("/invoices/123?tab=lines"));
    expect(response.status).toBe(307);
    expect(where(response)).toBe("/login?next=%2Finvoices%2F123%3Ftab%3Dlines");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    // Security headers still apply to the redirect.
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
  });

  it("uses 303 for a signed-out form post", () => {
    const response = proxy(request("/settings", { method: "POST" }));
    expect(response.status).toBe(303);
    expect(where(response)).toBe("/login?next=%2Fsettings");
  });

  it("lets public pages and API routes through without a cookie", () => {
    for (const path of [
      "/",
      "/login",
      "/invite",
      "/api/company",
      "/api/health",
    ]) {
      const response = proxy(request(path));
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it.each(["jobflow.session_token", "__Secure-jobflow.session_token"])(
    "passes a request with %s through",
    (name) => {
      const response = proxy(request("/home", { cookie: `${name}=abc` }));
      expect(response.headers.get("location")).toBeNull();
      // The layout gets the requested path to send a stale session back.
      expect(response.headers.get("x-middleware-request-x-jobflow-path")).toBe(
        "/home",
      );
    },
  );

  it("doesn't take a look-alike cookie as a session", () => {
    const response = proxy(
      request("/home", { cookie: "jobflow.session_token_x=abc" }),
    );
    expect(response.status).toBe(307);
  });
});

describe("signed-in pages are never cached (S1 AC8)", () => {
  it(
    "the (app) layout and account pages render dynamically",
    { timeout: 60_000 },
    async () => {
      // force-dynamic makes Next.js send "private, no-cache, no-store,
      // max-age=0, must-revalidate" in production (and no-store in dev).
      for (const load of [
        () => import("@/app/(app)/layout"),
        () => import("@/app/choose-company/page"),
        () => import("@/app/account/page"),
        () => import("@/app/onboarding/page"),
      ])
        expect((await load()).dynamic).toBe("force-dynamic");
    },
  );
  it("Next.js's dynamic header is private and no-store", async () => {
    const { getCacheControlHeader } =
      await import("next/dist/server/lib/cache-control");
    expect(getCacheControlHeader({ revalidate: 0, expire: undefined })).toMatch(
      /^private, .*no-store/,
    );
  });
});
