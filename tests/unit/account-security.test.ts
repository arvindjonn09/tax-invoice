import { describe, expect, it } from "vitest";
import { clientIp } from "../../apps/web/src/server/http/throttle";
import { contentSecurityPolicy } from "../../apps/web/src/server/security/headers";
import { isBreachedPassword } from "../../apps/web/src/server/security/pwned";
import { verifyTurnstile } from "../../apps/web/src/server/security/turnstile";

// #217: client IP trust, Turnstile verification and the breach check.
describe("clientIp", () => {
  const cloudflare = { CLIENT_IP_HEADER: "cf-connecting-ip" };

  it("trusts only the configured header behind Cloudflare", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4, 198.51.100.7",
      "cf-connecting-ip": "198.51.100.7",
    });
    expect(clientIp(headers, cloudflare)).toBe("198.51.100.7");
    // A spoofed X-Forwarded-For alone gives no address.
    expect(
      clientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }), cloudflare),
    ).toBeNull();
  });

  it("uses the first X-Forwarded-For hop behind nginx", () => {
    expect(
      clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), {}),
    ).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-real-ip": "2001:db8::1" }), {})).toBe(
      "2001:db8::1",
    );
  });

  it("ignores anything that isn't an IP address", () => {
    expect(
      clientIp(new Headers({ "x-forwarded-for": "x".repeat(500) }), {}),
    ).toBeNull();
    expect(
      clientIp(new Headers({ "cf-connecting-ip": "not-an-ip" }), cloudflare),
    ).toBeNull();
    expect(clientIp(new Headers(), {})).toBeNull();
  });
});

describe("verifyTurnstile", () => {
  const env = { TURNSTILE_SECRET_KEY: "secret" };
  const options = (body: unknown) => ({
    env,
    production: true,
    hostname: "jobflow.example.com",
    fetcher: async () => Response.json(body),
  });
  const good = {
    success: true,
    action: "signup",
    hostname: "jobflow.example.com",
  };

  it("accepts only a successful token for this action and hostname", async () => {
    expect(await verifyTurnstile("t", "signup", options(good))).toBe(true);
    for (const bad of [
      { ...good, success: false },
      { ...good, action: "resend" },
      { ...good, hostname: "evil.example" },
    ]) {
      expect(await verifyTurnstile("t", "signup", options(bad))).toBe(false);
    }
    expect(await verifyTurnstile(undefined, "signup", options(good))).toBe(
      false,
    );
  });

  it("skips without a secret outside production and fails closed in production", async () => {
    const base = { env: {}, hostname: "h" };
    expect(
      await verifyTurnstile(undefined, "signup", {
        ...base,
        production: false,
      }),
    ).toBe(true);
    expect(
      await verifyTurnstile(undefined, "signup", { ...base, production: true }),
    ).toBe(false);
  });

  it("fails closed when Cloudflare can't be reached", async () => {
    expect(
      await verifyTurnstile("t", "signup", {
        ...options(good),
        fetcher: () => Promise.reject(new Error("down")),
      }),
    ).toBe(false);
  });
});

describe("Turnstile CSP", () => {
  const base = { nonce: "n", development: false, https: true };

  it("allows Cloudflare's frame only on pages that ask for it", () => {
    expect(contentSecurityPolicy(base)).toContain("frame-src 'none'");
    expect(contentSecurityPolicy({ ...base, turnstile: true })).toContain(
      "frame-src https://challenges.cloudflare.com",
    );
  });
});

describe("isBreachedPassword", () => {
  // SHA-1 of "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
  const suffix = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

  it("sends only a 5-character prefix and matches the suffix", async () => {
    const urls: string[] = [];
    const result = await isBreachedPassword("password", async (url) => {
      urls.push(url);
      return new Response(`${suffix}:3\r\nAAAA:0\r\n`);
    });
    expect(result).toBe(true);
    expect(urls).toEqual(["https://api.pwnedpasswords.com/range/5BAA6"]);
  });

  it("ignores padding entries and fails open on an outage", async () => {
    expect(
      await isBreachedPassword(
        "password",
        async () => new Response(`${suffix}:0\r\n`),
      ),
    ).toBe(false);
    expect(
      await isBreachedPassword("password", () =>
        Promise.reject(new Error("down")),
      ),
    ).toBe(false);
  });
});
