import { describe, expect, it } from "vitest";
import { count } from "@/lib/plural";
import { taxLabel } from "@/features/invoices/types";

// #307: "1 employee", not "1 employees"; offers show a tax label, not a code.
describe("small clean-ups (#307)", () => {
  it("counts in the singular for one", () => {
    expect(count(0, "employee")).toBe("0 employees");
    expect(count(1, "employee")).toBe("1 employee");
    expect(count(2, "contractor")).toBe("2 contractors");
    expect(count(1, "match", "matches")).toBe("1 match");
    expect(count(3, "match", "matches")).toBe("3 matches");
  });
  it("labels tax codes for people", () => {
    expect(taxLabel("TAXABLE_10")).not.toBe("TAXABLE_10");
    expect(taxLabel("OUT_OF_SCOPE")).not.toBe("OUT_OF_SCOPE");
  });
});
