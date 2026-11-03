import { describe, expect, it } from "vitest";
import {
  READ_ONLY_ALLOWED,
  UNSAFE_METHODS,
  allowedWhileReadOnly,
  isCompanyReadOnlyError,
} from "../../apps/web/src/server/authz/read-only";
import { routeEntries } from "../helpers/route-matrix";

// #222: the read-only route allowlist stays small, real and explained.
describe("READ_ONLY_ALLOWED", () => {
  const entries = routeEntries();
  const policyRoutes = new Set(
    entries.filter((e) => e.permission).map((e) => `${e.method} ${e.route}`),
  );

  it("is exactly the ADR 0004 D4 list", () => {
    expect(Object.keys(READ_ONLY_ALLOWED).sort()).toEqual([
      "DELETE /api/users/invitations/[id]",
      "PATCH /api/users/[id]",
      "POST /api/documents/[id]/link",
      "POST /api/invoices/[id]/pdf",
    ]);
  });

  it("names only real withPolicy routes with unsafe methods, each with a reason", () => {
    for (const [key, reason] of Object.entries(READ_ONLY_ALLOWED)) {
      expect(policyRoutes.has(key), key).toBe(true);
      expect(UNSAFE_METHODS.has(key.split(" ")[0]!), key).toBe(true);
      expect(reason.trim().length, key).toBeGreaterThan(10);
    }
  });

  it("guards every other unsafe company route", () => {
    const unsafe = entries.filter(
      (e) => e.permission && UNSAFE_METHODS.has(e.method),
    );
    const open = unsafe.filter((e) =>
      allowedWhileReadOnly(e.method, e.route.replace(/\[[^\]]+\]/g, "x1")),
    );
    expect(open.map((e) => `${e.method} ${e.route}`).sort()).toEqual(
      Object.keys(READ_ONLY_ALLOWED).sort(),
    );
  });
});

describe("allowedWhileReadOnly", () => {
  it("allows safe methods everywhere", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"])
      expect(allowedWhileReadOnly(method, "/api/invoices")).toBe(true);
  });

  it("matches templates segment by segment, never by prefix", () => {
    expect(allowedWhileReadOnly("POST", "/api/invoices/abc/pdf")).toBe(true);
    expect(allowedWhileReadOnly("post", "/api/invoices/abc/pdf")).toBe(true);
    expect(allowedWhileReadOnly("POST", "/api/invoices/abc/issue")).toBe(false);
    expect(allowedWhileReadOnly("POST", "/api/invoices/a/b/pdf")).toBe(false);
    expect(allowedWhileReadOnly("POST", "/api/invoices/abc/pdf/x")).toBe(false);
    expect(allowedWhileReadOnly("PATCH", "/api/users/abc")).toBe(true);
    expect(allowedWhileReadOnly("DELETE", "/api/users/abc")).toBe(false);
    expect(allowedWhileReadOnly("POST", "/api/users/invitations")).toBe(false);
  });
});

describe("isCompanyReadOnlyError", () => {
  it("recognises the guard's SQLSTATE through adapter wrappers only", () => {
    const raw = { code: "55000", message: "jobflow_company_read_only" };
    expect(isCompanyReadOnlyError(raw)).toBe(true);
    expect(
      isCompanyReadOnlyError({
        code: "P2010",
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "55000",
              originalMessage: "jobflow_company_read_only",
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      isCompanyReadOnlyError({
        code: "55000",
        message: "jobflow_period_locked",
      }),
    ).toBe(false);
    expect(
      isCompanyReadOnlyError({
        code: "23505",
        message: "jobflow_company_read_only",
      }),
    ).toBe(false);
    expect(isCompanyReadOnlyError(null)).toBe(false);
    const cycle: Record<string, unknown> = {};
    cycle.cause = cycle;
    expect(isCompanyReadOnlyError(cycle)).toBe(false);
  });
});
