import { describe, expect, it } from "vitest";
import { ageingHref } from "@/features/reports/hub";

// #300 review: an on-account expense in "You owe" opens the expense, not a
// bill page that doesn't exist.
describe("ageing row links", () => {
  it("expense rows open the expense", () => {
    expect(ageingHref("payables", { id: "e1", kind: "expense" })).toBe(
      "/expenses/e1",
    );
  });
  it("bill rows open the bill; receivables open the invoice", () => {
    expect(ageingHref("payables", { id: "b1" })).toBe("/payments/bills/b1");
    expect(ageingHref("receivables", { id: "i1" })).toBe("/invoices/i1");
  });
});
