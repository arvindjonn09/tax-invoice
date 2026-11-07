import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { can } from "../../packages/authz/src/index";
import {
  MATRIX_DOC,
  matrixMarkdown,
  routeEntries,
} from "../helpers/route-matrix";

// #61 pre-production audit: the reviewed route/permission matrix is the
// code's, and worker roles reach only worker-facing routes.
describe("API route permission matrix", () => {
  const entries = routeEntries();

  it("is documented exactly as the code defines it", () => {
    expect(readFileSync(MATRIX_DOC, "utf8")).toBe(matrixMarkdown(entries));
  });

  it("covers every route method", () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(
      entries.filter((e) => e.permission === null).map((e) => e.route),
    ).toEqual(
      expect.arrayContaining([
        "/api/health",
        "/api/health/ready",
        "/api/auth/[...all]",
      ]),
    );
  });

  // Employees and subcontractors may reach only their own work, offers,
  // timesheets, expenses, uploads and the company header. Nothing that
  // reads or changes prices, costs, invoices, payments, reports or users.
  const WORKER_ROUTES = [
    /^\/api\/my\//,
    /^\/api\/documents$/,
    /^\/api\/documents\/\[id\]\/link$/,
    /^\/api\/timesheets$/,
    /^\/api\/timesheets\/\[id\]$/,
    /^\/api\/expenses$/,
    /^\/api\/expenses\/\[id\]$/,
    /^\/api\/company$/,
    // Workers learn only whether the company is read-only (#221, S8 AC2);
    // the dates and countdown need trial.read.
    /^\/api\/company\/trial$/,
    // The company header shows the logo; nothing else about the company.
    /^\/api\/company\/logo\/link$/,
  ];
  for (const role of ["employee", "subcontractor"] as const)
    it(`${role} reaches only worker-facing routes`, () => {
      const reachable = entries.filter(
        (e) => e.permission && can(role, e.permission),
      );
      expect(reachable.length).toBeGreaterThan(0);
      for (const e of reachable)
        expect(
          WORKER_ROUTES.some((pattern) => pattern.test(e.route)),
          `${role}: ${e.method} ${e.route} (${e.permission})`,
        ).toBe(true);
    });

  it("keeps exports, GST and full records to owners and accountants", () => {
    for (const e of entries)
      if (
        e.permission &&
        /^\/api\/(exports|reports\/(gst|ageing|cash)|company\/export)/.test(
          e.route,
        )
      )
        for (const role of ["manager", "employee", "subcontractor"])
          expect(can(role, e.permission), `${role} ${e.route}`).toBe(false);
  });
});
