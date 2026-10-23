import { describe, expect, it } from "vitest";
import { ROLES } from "../../packages/authz/src/index";
import {
  NAV_ITEMS,
  homeFor,
  navItemFor,
  navigationFor,
} from "../../apps/web/src/server/navigation";

const labels = (role: Parameters<typeof navigationFor>[0]) =>
  navigationFor(role).map((item) => item.label);

describe("navigationFor", () => {
  it("shows each role only the modules it can use", () => {
    expect(labels("employee")).toEqual(["Jobs", "Expenses", "Timesheets"]);
    expect(labels("subcontractor")).toEqual(["Jobs", "My offers"]);
    expect(labels("accountant")).toEqual([
      "Dashboard",
      "Jobs",
      "Customers",
      "Quotes",
      "Invoices",
      "Payments",
      "Expenses",
      "Employees",
      "Contractors",
      "Reports",
      "Settings",
    ]);
    expect(labels("owner")).not.toContain("My offers");
    expect(labels("owner")).toHaveLength(NAV_ITEMS.length - 1);
  });

  it("never shows financial modules to employees or subcontractors", () => {
    for (const role of ["employee", "subcontractor"] as const) {
      for (const hidden of [
        "Dashboard",
        "Customers",
        "Quotes",
        "Invoices",
        "Payments",
        "Reports",
        "Settings",
        "Contractors",
        "Employees",
      ]) {
        expect(labels(role)).not.toContain(hidden);
      }
    }
  });

  it("resolves only permitted modules and a sensible home", () => {
    expect(navItemFor("employee", "invoices")).toBeUndefined();
    expect(navItemFor("employee", "jobs")?.label).toBe("Jobs");
    expect(navItemFor("owner", "nope")).toBeUndefined();
    expect(homeFor("owner")).toBe("/dashboard");
    expect(homeFor("employee")).toBe("/jobs");
    expect(homeFor("subcontractor")).toBe("/jobs");
  });

  it("gives every role at least one module", () => {
    for (const role of ROLES)
      expect(navigationFor(role).length).toBeGreaterThan(0);
  });
});
