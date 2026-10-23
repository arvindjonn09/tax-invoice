import { describe, expect, it } from "vitest";
import {
  type InvoiceBalance,
  allocationGst,
  allocationProblems,
  jobProfit,
  receivable,
} from "../src/index";

const invoice = (overrides: Partial<InvoiceBalance> = {}): InvoiceBalance => ({
  invoiceId: "inv-1",
  inclusive: 275_000n,
  gst: 25_000n,
  credited: 0n,
  received: 0n,
  ...overrides,
});
const balances = (...list: InvoiceBalance[]) =>
  new Map(list.map((balance) => [balance.invoiceId, balance]));

describe("receipts (#50)", () => {
  it("fixture: $1,000 on a $2,750 invoice leaves $1,750; profit unchanged", () => {
    const before = invoice();
    expect(
      allocationProblems(
        "receipt",
        100_000n,
        [{ invoiceId: "inv-1", amount: 100_000n }],
        balances(before),
      ),
    ).toEqual([]);
    const after = { ...before, received: 100_000n };
    expect(receivable(after)).toBe(175_000n);
    // Profit is invoiced revenue (ex GST) minus cost: receipts never enter it.
    const profit = (b: InvoiceBalance) =>
      jobProfit({
        revenueExclusive: [b.inclusive - b.gst],
        jobCosts: [145_000n],
      });
    expect(profit(after)).toEqual(profit(before));
  });

  it("rejects overpayment, a split that doesn't add up, duplicates and unknown invoices", () => {
    const b = balances(
      invoice(),
      invoice({ invoiceId: "inv-2", inclusive: 50_000n, gst: 0n }),
    );
    const fields = (
      amount: bigint,
      allocations: { invoiceId: string; amount: bigint }[],
    ) =>
      allocationProblems("receipt", amount, allocations, b).map((p) => p.field);
    expect(
      fields(300_000n, [{ invoiceId: "inv-1", amount: 300_000n }]),
    ).toEqual(["allocations.0"]);
    expect(fields(100_000n, [{ invoiceId: "inv-1", amount: 90_000n }])).toEqual(
      ["allocations"],
    );
    expect(
      fields(100_000n, [
        { invoiceId: "inv-1", amount: 50_000n },
        { invoiceId: "inv-1", amount: 50_000n },
      ]),
    ).toEqual(["allocations.1"]);
    expect(fields(100_000n, [{ invoiceId: "nope", amount: 100_000n }])).toEqual(
      ["allocations.0"],
    );
    expect(fields(0n, [])).toEqual(["amountCents", "allocations"]);
    expect(fields(10n, [{ invoiceId: "inv-1", amount: 0n }])).toEqual([
      "allocations.0",
      "allocations",
    ]);
    // Across several invoices, exactly.
    expect(
      fields(150_000n, [
        { invoiceId: "inv-1", amount: 100_000n },
        { invoiceId: "inv-2", amount: 50_000n },
      ]),
    ).toEqual([]);
  });

  it("credits reduce what's receivable; it never goes negative", () => {
    expect(receivable(invoice({ credited: 75_000n, received: 100_000n }))).toBe(
      100_000n,
    );
    expect(receivable(invoice({ credited: 275_000n, received: 10n }))).toBe(0n);
  });

  it("refunds return at most what was received", () => {
    const b = balances(invoice({ received: 100_000n }));
    expect(
      allocationProblems(
        "refund",
        100_000n,
        [{ invoiceId: "inv-1", amount: 100_000n }],
        b,
      ),
    ).toEqual([]);
    expect(
      allocationProblems(
        "refund",
        100_001n,
        [{ invoiceId: "inv-1", amount: 100_001n }],
        b,
      ).map((p) => p.message),
    ).toEqual(["That's more than was received on this invoice"]);
  });

  it("attributes cash-basis GST cumulatively; a refund reverses its share", () => {
    // $1,100 of a $2,200 invoice with $200 GST → $100 GST (docs/GST.md #6).
    const half = invoice({ inclusive: 220_000n, gst: 20_000n });
    expect(allocationGst("receipt", 110_000n, half)).toBe(10_000n);
    const rest = { ...half, received: 110_000n };
    expect(allocationGst("receipt", 110_000n, rest)).toBe(10_000n);
    expect(allocationGst("refund", 110_000n, rest)).toBe(-10_000n);
  });
});
