import { describe, expect, it } from "vitest";
import { REDACTED, auditChanges } from "../../packages/database/src/audit";

describe("auditChanges", () => {
  it("records only fields that changed, in key order", () => {
    expect(
      auditChanges(
        { role: "employee", isActive: true, name: "Sample A" },
        { role: "manager", isActive: true, name: "Sample A" },
      ),
    ).toEqual({ role: { before: "employee", after: "manager" } });
  });

  it("records additions and removals as null on the missing side", () => {
    expect(auditChanges({}, { name: "Sample" })).toEqual({
      name: { before: null, after: "Sample" },
    });
    expect(auditChanges({ name: "Sample" })).toEqual({
      name: { before: "Sample", after: null },
    });
  });

  it("redacts sensitive values but still records that they changed", () => {
    expect(
      auditChanges(
        { email: "old@example.test", bankAccount: { bsb: "000-000" } },
        { email: "new@example.test", bankAccount: { bsb: "111-111" } },
      ),
    ).toEqual({
      bankAccount: { before: REDACTED, after: REDACTED },
      email: { before: REDACTED, after: REDACTED },
    });
  });

  it("redacts sensitive keys nested inside other values", () => {
    expect(
      auditChanges(
        { settings: { theme: "light", apiToken: "a" }, tags: [{ phone: "1" }] },
        { settings: { theme: "dark", apiToken: "b" }, tags: [{ phone: "2" }] },
      ),
    ).toEqual({
      settings: {
        before: { theme: "light", apiToken: REDACTED },
        after: { theme: "dark", apiToken: REDACTED },
      },
      tags: { before: [{ phone: REDACTED }], after: [{ phone: REDACTED }] },
    });
  });

  it("stores bigint cents as strings and dates as ISO strings", () => {
    expect(
      auditChanges(
        { totalCents: 250000n, issuedAt: new Date("2026-07-01T00:00:00Z") },
        { totalCents: 275000n, issuedAt: new Date("2026-07-02T00:00:00Z") },
      ),
    ).toEqual({
      issuedAt: {
        before: "2026-07-01T00:00:00.000Z",
        after: "2026-07-02T00:00:00.000Z",
      },
      totalCents: { before: "250000", after: "275000" },
    });
  });

  it("returns no changes when nothing differs", () => {
    expect(auditChanges({ a: 1n }, { a: 1n })).toEqual({});
  });
});
