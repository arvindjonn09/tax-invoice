import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Guard for #14: a route handler or server action without an explicit
// authorisation policy fails CI. Public exceptions must be listed with a reason.
const APP = join(import.meta.dirname, "../../apps/web/src/app");
const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

const PUBLIC_ROUTES: Record<string, string> = {
  "api/invitations/accept/route.ts":
    "One-use invitation token authorizes acceptance; explicit origin/body/rate guards, existing-account identity check and transactionally scoped role grant",
  "api/health/route.ts": "liveness probe; returns no data",
  "api/health/ready/route.ts":
    "readiness probe; returns only ready/not ready, no configuration",
  "api/files/[token]/route.ts":
    "signed 5-minute download token minted by /api/documents/[id]/link after authz; HMAC-verified, company-bound, served as a sandboxed attachment",
  "api/account/sign-up/route.ts":
    "Public sign-up (ADR 0004 D1): origin/body guards, IP throttle, Turnstile, identical 202 for new and existing emails; creates only an unverified user",
  "api/account/verify-email/route.ts":
    "Single-use 256-bit emailed token (digest stored, 24 h) authorizes marking that one address verified; IP throttle",
  "api/account/verification/resend/route.ts":
    "Public resend: same 202 whatever the address; IP, per-account and Turnstile limits; never reveals an account",
  "api/account/verification/resend-mine/route.ts":
    "Requires a session; acts only on the caller's own unverified account; per-account limits",
  "api/onboarding/company/route.ts":
    "Requires a verified session; creates only the caller's own first company (one per user, idempotency key) with the caller as Owner; origin/body/throttle guards",
  "api/session/company/route.ts":
    "Requires a verified session; sets the session's company only to one where the caller is an active member, else 404; origin and size guards",
  "api/auth/[...all]/route.ts":
    "Better Auth endpoints: sign-in/out and session; they enforce their own origin checks and throttling",
};
const POLICY_FREE_ACTIONS: Record<string, string> = {
  "account/page.tsx": "sign-out only affects the caller's own session",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

const all = files(APP).map((path) => ({
  path: relative(APP, path).replaceAll("\\", "/"),
  source: readFileSync(path, "utf8"),
}));

describe("route handlers", () => {
  const routes = all.filter(({ path }) => /(^|\/)route\.tsx?$/.test(path));

  it("finds the route files", () => {
    expect(routes.map(({ path }) => path)).toContain("api/company/route.ts");
  });

  for (const { path, source } of routes) {
    if (path in PUBLIC_ROUTES) continue;
    it(`${path} wraps every HTTP method in withPolicy`, () => {
      expect(source).not.toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+(${METHODS})\\b`),
      );
      const exported = [
        ...source.matchAll(
          new RegExp(`export\\s+const\\s+(${METHODS})\\s*=\\s*([^\\n]*)`, "g"),
        ),
      ];
      expect(exported.length).toBeGreaterThan(0);
      for (const [, method, value] of exported) {
        expect(value, `${method} in ${path}`).toMatch(/^withPolicy\(/);
      }
    });
  }

  it("lists only public routes that still exist", () => {
    const paths = routes.map(({ path }) => path);
    for (const path of Object.keys(PUBLIC_ROUTES))
      expect(paths).toContain(path);
  });
});

describe("server actions", () => {
  const actions = all.filter(({ source }) => /["']use server["']/.test(source));
  for (const { path, source } of actions) {
    if (path in POLICY_FREE_ACTIONS) continue;
    it(`${path} calls requireActor(...)`, () => {
      expect(source).toMatch(/requireActor\(/);
    });
  }
  it("lists only policy-free actions that still exist", () => {
    const paths = actions.map(({ path }) => path);
    for (const path of Object.keys(POLICY_FREE_ACTIONS))
      expect(paths).toContain(path);
  });
});
