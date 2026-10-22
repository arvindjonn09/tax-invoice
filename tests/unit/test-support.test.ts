import { describe, expect, it } from "vitest";
import {
  REFERENCE_INSTANT,
  assertScope,
  createSequence,
  syntheticCompanyName,
  syntheticEmail,
  syntheticPersonName,
} from "../support/synthetic";

describe("deterministic test environment", () => {
  it("runs in UTC regardless of the host time zone", () => {
    expect(process.env.TZ).toBe("UTC");
    expect(new Date(REFERENCE_INSTANT).getTimezoneOffset()).toBe(0);
    expect(REFERENCE_INSTANT.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("synthetic values", () => {
  it("are reproducible for the same scope and sequence", () => {
    const first = createSequence();
    const second = createSequence();
    expect([first(), first(), first()]).toEqual([1, 2, 3]);
    expect([second(), second()]).toEqual([1, 2]);
    expect(syntheticEmail("invoices", 2)).toBe("invoices-user-2@example.test");
    expect(syntheticCompanyName("invoices", 2)).toBe(
      "Sample Company invoices 2",
    );
    expect(syntheticPersonName("invoices", 2)).toBe("Sample Person invoices 2");
  });

  it("use the reserved .test domain so mail can never be delivered", () => {
    expect(syntheticEmail("jobs", 1)).toMatch(/@example\.test$/);
  });

  it.each(["", "Upper", "has space", "1starts-with-digit", "x".repeat(32)])(
    "rejects unsafe scope %j",
    (scope) => {
      expect(() => assertScope(scope)).toThrow("Invalid synthetic scope");
    },
  );
});
