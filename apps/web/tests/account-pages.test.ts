import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retryAfter, throttledText, waitText } from "@/lib/retry";
import { proxy } from "@/proxy";

// #224: Turnstile CSP only where the widget is; token pages send no referrer.
const get = (path: string) =>
  proxy(new NextRequest(`http://127.0.0.1:3000${path}`));
const csp = (path: string) =>
  get(path).headers.get("content-security-policy") ?? "";

describe("account page headers (#224)", () => {
  // Turnstile is on only where a site key is configured.
  beforeAll(() => vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA"));
  afterAll(() => vi.unstubAllEnvs());
  it.each(["/signup", "/forgot-password", "/verify-email"])(
    "%s allows Cloudflare Turnstile",
    (path) => {
      expect(csp(path)).toMatch(
        /script-src[^;]*https:\/\/challenges\.cloudflare\.com/,
      );
      expect(csp(path)).toContain(
        "frame-src https://challenges.cloudflare.com",
      );
    },
  );

  it.each(["/", "/login", "/reset-password", "/verify-email/pending", "/home"])(
    "%s keeps the strict CSP",
    (path) => {
      expect(csp(path)).not.toContain("challenges.cloudflare.com");
      expect(csp(path)).toContain("frame-src 'none'");
    },
  );

  it.each(["/verify-email", "/reset-password"])(
    "%s sends Referrer-Policy: no-referrer",
    (path) => {
      expect(get(path).headers.get("referrer-policy")).toBe("no-referrer");
    },
  );

  it("other pages keep the default referrer policy", () => {
    expect(get("/forgot-password").headers.get("referrer-policy")).not.toBe(
      "no-referrer",
    );
  });
});

describe("throttled wait text", () => {
  it.each([
    [1, "1 minute"],
    [59, "1 minute"],
    [61, "2 minutes"],
    [240, "4 minutes"],
    [89 * 60, "89 minutes"],
    [90 * 60, "2 hours"],
    [3600 * 5, "5 hours"],
  ])("%i s → %s", (seconds, text) => {
    expect(waitText(seconds)).toBe(text);
  });
  it("no wait given: no countdown", () => {
    expect(waitText(undefined)).toBeNull();
    expect(throttledText(null)).toBe(
      "Too many attempts. Try again in a few minutes.",
    );
    expect(throttledText(240)).toBe(
      "Too many attempts. You can try again in 4 minutes.",
    );
  });
  it("reads the body first, then Retry-After", () => {
    const response = new Response(null, { headers: { "retry-after": "120" } });
    expect(retryAfter(response, { retryAfterSeconds: 30 })).toBe(30);
    expect(retryAfter(response, null)).toBe(120);
    expect(retryAfter(new Response(null), {})).toBeNull();
  });
});
