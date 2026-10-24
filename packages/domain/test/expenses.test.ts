// #40 Expenses: GST treatment, cost on approval and settlement, asserted
// together with job profit on the combined fixture
// (docs/GST.md#combined-gst-and-profit-acceptance-fixture). Cents throughout.
import { describe, expect, it } from "vitest";
import {
  LOW_VALUE_PURCHASE_CENTS,
  calculatePurchase,
  expenseCost,
  expenseLine,
  expenseTotals,
  hasPurchaseEvidence,
  internalCost,
  jobProfit,
  percentToBasisPoints,
  reverseExpense,
} from "../src/index";

const materials = (priceEntry: "exclusive" | "inclusive" = "exclusive") =>
  expenseLine({
    amount: priceEntry === "exclusive" ? 15000n : 16500n,
    priceEntry,
    taxCode: "TAXABLE_10",
  });

const registered = {
  companyRegistered: true,
  document: "tax_invoice" as const,
  evidenceVerified: true,
  creditableBasisPoints: 10_000n,
};

describe("issue fixtures: materials $150 + $15 GST", () => {
  it("creditable → cost $150 (the $15 is a credit, never cost)", () => {
    const cost = expenseCost(materials(), registered);
    expect(cost).toMatchObject({
      exclusive: 15000n,
      gst: 1500n,
      inclusive: 16500n,
      creditableGst: 1500n,
      nonCreditableGst: 0n,
      jobCost: 15000n,
    });
  });

  it("non-creditable → cost $165", () => {
    for (const input of [
      { ...registered, companyRegistered: false },
      { ...registered, creditableBasisPoints: 0n },
      { ...registered, document: null },
      { ...registered, evidenceVerified: false },
      { ...registered, document: "receipt" as const },
    ]) {
      expect(expenseCost(materials(), input).jobCost).toBe(16500n);
    }
  });

  it("GST-inclusive entry gives the same split", () => {
    expect(materials("inclusive")).toEqual(materials());
  });

  it("partly creditable: business-use share only", () => {
    const cost = expenseCost(materials(), {
      ...registered,
      creditableBasisPoints: percentToBasisPoints("60"),
    });
    expect(cost).toMatchObject({
      creditableGst: 900n,
      nonCreditableGst: 600n,
      jobCost: 15600n,
    });
  });
});

describe("evidence (R5, R6): verified qualifying documents only", () => {
  it("above 8250 incl. GST: only a verified tax invoice qualifies", () => {
    expect(LOW_VALUE_PURCHASE_CENTS).toBe(8250n);
    const above = { inclusive: 8251n, verified: true };
    expect(hasPurchaseEvidence({ ...above, document: "tax_invoice" })).toBe(
      true,
    );
    expect(hasPurchaseEvidence({ ...above, document: "receipt" })).toBe(false);
    expect(hasPurchaseEvidence({ ...above, document: null })).toBe(false);
    expect(
      hasPurchaseEvidence({
        ...above,
        document: "tax_invoice",
        verified: false,
      }),
    ).toBe(false);
  });

  it("at or below 8250: retained alternative evidence (a receipt) qualifies, nothing does not", () => {
    const low = { inclusive: 8250n, verified: true };
    expect(hasPurchaseEvidence({ ...low, document: "receipt" })).toBe(true);
    expect(hasPurchaseEvidence({ ...low, document: null })).toBe(false);
    expect(
      hasPurchaseEvidence({ ...low, document: "receipt", verified: false }),
    ).toBe(false);
    const line = expenseLine({
      amount: 8250n,
      priceEntry: "inclusive",
      taxCode: "TAXABLE_10",
    });
    expect(
      expenseCost(line, { ...registered, document: "receipt" }),
    ).toMatchObject({ gst: 750n, creditableGst: 750n, jobCost: 7500n });
    expect(expenseCost(line, { ...registered, document: null })).toMatchObject({
      creditableGst: 0n,
      jobCost: 8250n,
    });
  });
});

describe("tax codes and bounds", () => {
  it("zero-rated codes carry no GST, so cost is the whole amount", () => {
    for (const taxCode of [
      "GST_FREE",
      "INPUT_TAXED",
      "OUT_OF_SCOPE",
    ] as const) {
      const line = expenseLine({
        amount: 2000n,
        priceEntry: "inclusive",
        taxCode,
      });
      expect(line).toMatchObject({ exclusive: 2000n, gst: 0n });
      expect(expenseCost(line, registered).jobCost).toBe(2000n);
    }
  });

  it("refuses negative amounts and out-of-range shares", () => {
    expect(() =>
      expenseLine({
        amount: -1n,
        priceEntry: "exclusive",
        taxCode: "GST_FREE",
      }),
    ).toThrow(/reversal/);
    expect(() =>
      expenseCost(materials(), {
        ...registered,
        creditableBasisPoints: 10_001n,
      }),
    ).toThrow();
    expect(percentToBasisPoints("100")).toBe(10_000n);
    expect(percentToBasisPoints("12.5")).toBe(1250n);
    expect(() => percentToBasisPoints("100.01")).toThrow();
    expect(() => percentToBasisPoints("-5")).toThrow();
  });
});

describe("reversal", () => {
  it("cancels the original's exact cents", () => {
    const original = expenseCost(materials(), {
      ...registered,
      creditableBasisPoints: 3333n,
    });
    const reversal = reverseExpense(original);
    for (const key of Object.keys(original) as (keyof typeof original)[]) {
      expect(original[key] + reversal[key], key).toBe(0n);
    }
  });
});

describe("settlement: neither option double-counts, cash and outstanding reconcile", () => {
  const approved = (settlement: "paid_at_purchase" | "on_account") => {
    const cost = expenseCost(materials(), registered);
    return {
      settlement,
      inclusive: cost.inclusive,
      jobCost: cost.jobCost,
      creditableGst: cost.creditableGst,
    };
  };

  it("paid at purchase: cash 16500, nothing owed, cost 15000", () => {
    expect(expenseTotals([approved("paid_at_purchase")])).toEqual({
      cost: 15000n,
      creditableGst: 1500n,
      cashPaid: 16500n,
      supplierOutstanding: 0n,
    });
  });

  it("on account: no cash yet, 16500 owed, the same cost 15000", () => {
    expect(expenseTotals([approved("on_account")])).toEqual({
      cost: 15000n,
      creditableGst: 1500n,
      cashPaid: 0n,
      supplierOutstanding: 16500n,
    });
  });

  it("a cost-only reversal moves no cash and no supplier balance", () => {
    const paid = approved("paid_at_purchase");
    const correction = {
      settlement: null,
      inclusive: -paid.inclusive,
      jobCost: -paid.jobCost,
      creditableGst: -paid.creditableGst,
    };
    expect(expenseTotals([paid, correction])).toEqual({
      cost: 0n,
      creditableGst: 0n,
      cashPaid: 16500n,
      supplierOutstanding: 0n,
    });
    // Resubmitted correctly: cost once, still one payment, no invented refund.
    expect(
      expenseTotals([paid, correction, approved("paid_at_purchase")]),
    ).toMatchObject({ cost: 15000n, cashPaid: 33000n });
  });

  it("an explicit refund or supplier credit moves cash or the balance", () => {
    const paid = approved("paid_at_purchase");
    const onAccount = approved("on_account");
    const negate = (row: typeof paid) => ({
      ...row,
      inclusive: -row.inclusive,
      jobCost: -row.jobCost,
      creditableGst: -row.creditableGst,
    });
    const rows = [
      paid,
      negate(paid),
      onAccount,
      negate(onAccount),
      approved("on_account"),
    ];
    const totals = expenseTotals(rows);
    expect(totals).toEqual({
      cost: 15000n,
      creditableGst: 1500n,
      cashPaid: 0n,
      supplierOutstanding: 16500n,
    });
    expect(totals.cashPaid + totals.supplierOutstanding).toBe(
      rows.reduce((total, row) => total + row.inclusive, 0n),
    );
  });
});

describe("combined fixture: materials and travel as approved expenses", () => {
  const sale = [250000n];
  const subcontractor = calculatePurchase({
    exclusive: 90000n,
    gst: 9000n,
    buyerRegistered: true,
    hasEvidence: true,
  }).jobCost;
  const labour = internalCost(30000n).jobCost;
  const travel = expenseCost(
    expenseLine({
      amount: 10000n,
      priceEntry: "exclusive",
      taxCode: "GST_FREE",
    }),
    registered,
  ).jobCost;

  it("registered, creditable materials: cost 145000, profit 105000, 42%", () => {
    const materialsCost = expenseCost(materials(), registered).jobCost;
    expect(
      jobProfit({
        revenueExclusive: sale,
        jobCosts: [subcontractor, labour, materialsCost, travel],
      }),
    ).toEqual({
      revenue: 250000n,
      cost: 145000n,
      profit: 105000n,
      marginBasisPoints: 4200n,
    });
  });

  it("non-creditable materials: cost 146500, profit 103500", () => {
    const materialsCost = expenseCost(materials(), {
      ...registered,
      document: null,
    }).jobCost;
    const result = jobProfit({
      revenueExclusive: sale,
      jobCosts: [subcontractor, labour, materialsCost, travel],
    });
    expect(result).toMatchObject({ cost: 146500n, profit: 103500n });
  });

  it("unapproved expenses are not incurred cost", () => {
    // Only approved rows reach expenseTotals; a submitted one adds nothing.
    expect(expenseTotals([]).cost).toBe(0n);
    expect(
      jobProfit({ revenueExclusive: sale, jobCosts: [subcontractor, labour] })
        .cost,
    ).toBe(120000n);
  });
});
