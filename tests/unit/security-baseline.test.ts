import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  HttpError,
  MAX_JSON_BYTES,
  PAGE_SIZE_MAX,
  parsePage,
  readJson,
  requireBodyWithin,
  requireTrustedOrigin,
} from "../../apps/web/src/server/http/guards";
import { clientIp } from "../../apps/web/src/server/http/throttle";
import {
  REDACTED,
  log,
  redact,
  safeError,
  setLogSink,
} from "../../apps/web/src/server/log";
import {
  HSTS,
  contentSecurityPolicy,
  createNonce,
  securityHeaders,
} from "../../apps/web/src/server/security/headers";

const APP = "https://jobflow.example.test";

describe("security headers", () => {
  const base = { nonce: "abc123", development: false, https: true };

  it("sends a strict nonce CSP without unsafe-inline/eval scripts in production", () => {
    const csp = contentSecurityPolicy(base);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(csp).toContain("style-src 'self' 'nonce-abc123'");
    expect(csp).not.toMatch(/style-src [^;]*unsafe-inline/);
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ])
      expect(csp).toContain(directive);
  });

  it("allows eval only in next dev, and skips HTTPS-only parts over HTTP", () => {
    const dev = contentSecurityPolicy({
      ...base,
      development: true,
      https: false,
    });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(
      securityHeaders({ ...base, https: false })["Strict-Transport-Security"],
    ).toBeUndefined();
  });

  it("sets frame, sniffing, referrer, permissions and HSTS headers", () => {
    expect(securityHeaders(base)).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Strict-Transport-Security": HSTS,
    });
    expect(securityHeaders(base)["Permissions-Policy"]).toContain("camera=()");
  });

  it("creates unpredictable 128-bit nonces", () => {
    const nonces = new Set(Array.from({ length: 100 }, createNonce));
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) expect(atob(nonce)).toHaveLength(16);
  });

  it("does not widen server-action origins beyond the app's own host", () => {
    // Next.js rejects server actions whose Origin differs from Host unless
    // allowedOrigins lists it; keep that list empty.
    // (Read as text: importing next.config pulls Next's global types in.)
    const config = readFileSync(
      new URL("../../apps/web/next.config.ts", import.meta.url),
      "utf8",
    );
    expect(config).not.toMatch(/serverActions|allowedOrigins/);
    expect(config).toContain("poweredByHeader: false");
  });
});

describe("origin check (CSRF)", () => {
  const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`${APP}/api/company`, { method, headers });

  it("lets safe methods through without an Origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"])
      expect(() => requireTrustedOrigin(request(method), [APP])).not.toThrow();
  });

  it.each([
    ["no Origin", {}],
    ["another site", { origin: "https://evil.example" }],
    ["a look-alike", { origin: `${APP}.evil.example` }],
    ["the null origin", { origin: "null" }],
    [
      "cross-site fetch metadata",
      { origin: APP, "sec-fetch-site": "cross-site" },
    ],
  ])("refuses a mutation from %s", (_, headers) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() =>
        requireTrustedOrigin(request(method, headers), [APP]),
      ).toThrowError(expect.objectContaining({ status: 403 }));
    }
  });

  it("refuses every mutation when no origin is configured (fail closed)", () => {
    expect(() =>
      requireTrustedOrigin(request("POST", { origin: APP }), []),
    ).toThrowError(HttpError);
  });

  it("accepts a same-origin mutation", () => {
    expect(() =>
      requireTrustedOrigin(
        request("PATCH", { origin: APP, "sec-fetch-site": "same-origin" }),
        [APP],
      ),
    ).not.toThrow();
  });
});

describe("request bodies", () => {
  const json = (body: string, headers: Record<string, string> = {}) =>
    new Request(`${APP}/api/x`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("refuses a declared oversized body before reading it", () => {
    expect(() =>
      requireBodyWithin(
        json("{}", { "content-length": String(MAX_JSON_BYTES + 1) }),
        MAX_JSON_BYTES,
      ),
    ).toThrowError(expect.objectContaining({ status: 413 }));
  });

  it("counts streamed bytes, so a missing Content-Length cannot bypass the limit", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000).fill(32));
        controller.enqueue(new Uint8Array(40_000).fill(32));
        controller.close();
      },
    });
    const request = new Request(`${APP}/api/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
      duplex: "half",
    } as RequestInit);
    await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
  });

  it("parses JSON and rejects non-JSON or malformed bodies", async () => {
    await expect(readJson(json('{"name":"Sample"}'))).resolves.toEqual({
      name: "Sample",
    });
    await expect(readJson(json("{nope"))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      readJson(json("{}", { "content-type": "text/plain" })),
    ).rejects.toMatchObject({ status: 415 });
  });
});

describe("pagination", () => {
  const page = (query: string) => parsePage(new URLSearchParams(query));

  it("defaults, clamps and never returns an unbounded page", () => {
    expect(page("")).toEqual({ page: 1, take: 25, skip: 0 });
    expect(page("page=3&pageSize=10")).toEqual({ page: 3, take: 10, skip: 20 });
    expect(page("pageSize=100000").take).toBe(PAGE_SIZE_MAX);
    expect(page("pageSize=0").take).toBe(1);
    expect(page("pageSize=-5&page=-2")).toEqual({ page: 1, take: 1, skip: 0 });
    expect(page("page=abc&pageSize=1e3")).toEqual({
      page: 1,
      take: 100,
      skip: 0,
    });
    expect(page("page=99999999").page).toBe(10_000);
  });
});

describe("log redaction", () => {
  // Generated per run: no secret-shaped literals in the repository.
  const password = randomBytes(9).toString("base64url");
  const token = randomBytes(9).toString("hex");
  const synthetic = {
    reference: "d0000000-0000-4000-8000-000000000001",
    at: "2026-10-23T00:00:00.000Z",
    password,
    sessionToken: token,
    headers: { cookie: "jobflow.session=xyz", authorization: "Bearer abc.def" },
    customer: {
      abn: "51 824 753 556",
      bsb: "062-000",
      accountNumber: "12345678",
      email: "someone@example.test",
      phone: "+61 412 345 678",
      address: "1 Sample St",
    },
    upload: { contents: "raw file bytes" },
    note: "Contact someone@example.test or 0412345678 re ABN 51824753556",
    url: "https://bucket.example/obj?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA/x&part=1",
    amountCents: 125000n,
  };

  it("removes secrets, contact, bank and tax identifiers and signed URLs", () => {
    const out = JSON.stringify(redact(synthetic));
    for (const secret of [
      password,
      token,
      "xyz",
      "abc.def",
      "51 824 753 556",
      "51824753556",
      "062-000",
      "12345678",
      "someone@example.test",
      "412 345 678",
      "0412345678",
      "1 Sample St",
      "raw file bytes",
      "deadbeef",
      "AKIA",
    ])
      expect(out, secret).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it("keeps ids, timestamps and non-sensitive structure readable", () => {
    const out = redact(synthetic) as Record<string, unknown>;
    expect(out.reference).toBe(synthetic.reference);
    expect(out.at).toBe(synthetic.at);
    expect(String(out.url)).toContain("part=1");
  });

  it("logs errors by class and redacted message, never the cause or stack", () => {
    const error = new Error("insert failed for someone@example.test", {
      cause: { password: "x" },
    });
    expect(safeError(error)).toEqual({
      name: "Error",
      message: `insert failed for ${REDACTED}`,
    });
    expect(safeError("string")).toEqual({
      name: "NonError",
      message: REDACTED,
    });

    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      log("error", "test.event", { error, body: { password: "x" } });
    } finally {
      restore();
    }
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({ level: "error", event: "test.event" });
    expect(lines[0]).not.toContain("example.test");
    expect(lines[0]).not.toContain("stack");
    expect(entry.body).toBe(REDACTED);
  });
});

describe("client IP", () => {
  it("uses the first forwarded hop", () => {
    expect(
      clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBeNull();
  });
});
