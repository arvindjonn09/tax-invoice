import { describe, expect, it } from "vitest";
import {
  type Actor,
  AuthzError,
  PERMISSIONS,
  ROLES,
  can,
  companyScope,
  permissionsOf,
  requirePermission,
  requireSameCompany,
  visibleFields,
} from "../src/index";

const actor = (role: Actor["role"]): Actor => ({
  userId: "user-1",
  companyId: "company-a",
  role,
});

describe("policy matrix", () => {
  it("denies unknown roles and permissions by default", () => {
    expect(can("owner", "invoice.delete_everything")).toBe(false);
    expect(can("superuser", "company.read")).toBe(false);
    expect(can("", "")).toBe(false);
  });

  it("gives the owner every permission and every role company.read", () => {
    expect(permissionsOf("owner")).toEqual([...PERMISSIONS]);
    for (const role of ROLES) expect(can(role, "company.read")).toBe(true);
  });

  it("never lets employees or subcontractors see prices, profit, cost rates or company-wide finance", () => {
    const restricted = [
      "job.price.read",
      "job.profit.read",
      "job.read_all",
      "employee.cost_rate.read",
      "customer.read",
      "quote.read",
      "quote.write",
      "invoice.read",
      "invoice.write",
      "invoice.issue",
      "bill.read",
      "bill.write",
      "payment.read",
      "payment.write",
      "report.read",
      "gst_report.read",
      "export.run",
      "contractor.read",
      "user.read",
      "audit.read",
    ] as const;
    for (const role of ["employee", "subcontractor"] as const) {
      for (const permission of restricted) {
        expect(can(role, permission), `${role} ${permission}`).toBe(false);
      }
    }
  });

  it("matches the documented role summary", () => {
    expect(can("manager", "job.assign")).toBe(true);
    expect(can("manager", "expense.approve")).toBe(true);
    expect(can("manager", "expense.submit_own")).toBe(true);
    expect(can("accountant", "expense.submit_own")).toBe(false);
    expect(can("manager", "invoice.issue")).toBe(false);
    expect(can("manager", "gst_settings.update")).toBe(false);
    expect(can("accountant", "invoice.issue")).toBe(true);
    expect(can("accountant", "gst_report.read")).toBe(true);
    expect(can("accountant", "job.assign")).toBe(false);
    expect(can("accountant", "user.manage")).toBe(false);
    expect(can("employee", "timesheet.submit_own")).toBe(true);
    expect(can("subcontractor", "offer.respond_own")).toBe(true);
    expect(can("subcontractor", "timesheet.submit_own")).toBe(false);
    for (const role of [
      "manager",
      "accountant",
      "employee",
      "subcontractor",
    ] as const) {
      expect(can(role, "company.update")).toBe(false);
      expect(can(role, "user.manage")).toBe(false);
    }
  });
});

describe("guards", () => {
  it("returns 401 without an actor and 403 without the permission", () => {
    expect(() => requirePermission(null, "company.read")).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
    expect(() =>
      requirePermission(actor("employee"), "invoice.read"),
    ).toThrowError(expect.objectContaining({ status: 403 }));
    expect(requirePermission(actor("owner"), "invoice.read")).toEqual(
      actor("owner"),
    );
  });

  it("forces the actor's company into every query, ignoring forged input", () => {
    expect(companyScope(actor("owner"))).toEqual({ companyId: "company-a" });
    expect(
      companyScope(actor("owner"), { companyId: "company-b", status: "open" }),
    ).toEqual({ companyId: "company-a", status: "open" });
  });

  it("reports another company's record (or a missing one) as not found", () => {
    const own = { id: "x", companyId: "company-a" };
    expect(requireSameCompany(actor("owner"), own)).toBe(own);
    for (const record of [
      null,
      undefined,
      { id: "y", companyId: "company-b" },
    ]) {
      try {
        requireSameCompany(actor("owner"), record);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AuthzError);
        expect((error as AuthzError).status).toBe(404);
      }
    }
  });
});

describe("visibleFields", () => {
  type Job = {
    id: string;
    title: string;
    agreedPriceCents: bigint;
    profitCents: bigint;
    notes: string;
  };
  const job: Job = {
    id: "j1",
    title: "Sample job",
    agreedPriceCents: 250000n,
    profitCents: 105000n,
    notes: "internal",
  };
  const rules = {
    id: true,
    title: true,
    agreedPriceCents: "job.price.read",
    profitCents: "job.profit.read",
  } as const;

  it("returns only allowed fields, and never unlisted ones", () => {
    expect(visibleFields(actor("manager"), job, rules)).toEqual({
      id: "j1",
      title: "Sample job",
      agreedPriceCents: 250000n,
      profitCents: 105000n,
    });
    for (const role of ["employee", "subcontractor"] as const) {
      expect(visibleFields(actor(role), job, rules)).toEqual({
        id: "j1",
        title: "Sample job",
      });
    }
  });

  it("skips listed fields the record doesn't have", () => {
    expect(
      visibleFields(actor("owner"), { id: "x" } as Partial<Job>, rules),
    ).toEqual({ id: "x" });
  });
});
