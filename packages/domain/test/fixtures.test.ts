// The combined GST + job-profit acceptance fixtures (README, docs/GST.md and
// docs/research/domain-gst-profit.md) in ONE suite. All amounts are cents.
import { describe, expect, it } from "vitest";
import {
  allocateProRata,
  calculatePurchase,
  calculateSupplyLine,
  cashAttributedGst,
  documentTotals,
  draftBasSummary,
  internalCost,
  jobProfit,
  outstanding,
  reverseLine,
} from "../src/index";

const sale = (registered: boolean) =>
  calculateSupplyLine({
    quantity: "1",
    unitPrice: 250000n,
    priceEntry: "exclusive",
    taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
    supplierRegistered: registered,
  });

/** The job's costs for a GST-registered company (all with valid evidence). */
const registeredCosts = (
  materialsCreditable = { numerator: 1n, denominator: 1n },
) => ({
  subcontractor: calculatePurchase({
    exclusive: 90000n,
    gst: 9000n,
    buyerRegistered: true,
    hasEvidence: true,
  }),
  labour: internalCost(30000n),
  materials: calculatePurchase({
    exclusive: 15000n,
    gst: 1500n,
    buyerRegistered: true,
    hasEvidence: true,
    creditableFraction: materialsCreditable,
  }),
  travel: calculatePurchase({
    exclusive: 10000n,
    gst: 0n,
    buyerRegistered: true,
    hasEvidence: true,
  }),
});

const profitOf = (revenue: bigint, costs: { jobCost: bigint }[]) =>
  jobProfit({
    revenueExclusive: [revenue],
    jobCosts: costs.map((cost) => cost.jobCost),
  });

describe("README fixture: not registered for GST", () => {
  const invoice = sale(false);
  const costs = [
    internalCost(90000n),
    internalCost(30000n),
    internalCost(15000n),
    internalCost(10000n),
  ];

  it("charges no GST and keeps the $2,500 price", () => {
    expect(invoice).toMatchObject({
      exclusive: 250000n,
      gst: 0n,
      inclusive: 250000n,
    });
  });

  it("gives cost $1,450, profit $1,050 and margin 42%", () => {
    expect(profitOf(invoice.exclusive, costs)).toEqual({
      revenue: 250000n,
      cost: 145000n,
      profit: 105000n,
      marginBasisPoints: 4200n,
    });
  });

  it("leaves $1,500 owed by the customer and $500 to the subcontractor; profit unchanged", () => {
    expect(
      outstanding({ charged: [invoice.inclusive], settled: [100000n] }),
    ).toBe(150000n);
    expect(outstanding({ charged: [90000n], settled: [40000n] })).toBe(50000n);
    expect(profitOf(invoice.exclusive, costs).profit).toBe(105000n);
  });

  it("treats supplier GST as cost when the buyer cannot claim it", () => {
    // Same supplier gross invoices (99000, 16500) bought by an unregistered company.
    const gross = [
      calculatePurchase({
        exclusive: 90000n,
        gst: 9000n,
        buyerRegistered: false,
        hasEvidence: true,
      }),
      internalCost(30000n),
      calculatePurchase({
        exclusive: 15000n,
        gst: 1500n,
        buyerRegistered: false,
        hasEvidence: true,
      }),
      internalCost(10000n),
    ];
    const result = profitOf(250000n, gross);
    expect(result.cost).toBe(155500n);
    expect(result.profit).toBe(94500n);
  });
});

describe("docs/GST.md fixture: registered, non-cash basis, same period", () => {
  const invoice = sale(true);
  const costs = registeredCosts();
  const all = Object.values(costs);

  it("issues a $2,750 tax invoice ($2,500 + $250 GST)", () => {
    expect(invoice).toEqual({
      taxCode: "TAXABLE_10",
      rateBasisPoints: 1000n,
      exclusive: 250000n,
      gst: 25000n,
      inclusive: 275000n,
    });
  });

  it("keeps cost $1,450, profit $1,050 and margin 42%: GST does not change profit", () => {
    expect(profitOf(invoice.exclusive, all)).toEqual({
      revenue: 250000n,
      cost: 145000n,
      profit: 105000n,
      marginBasisPoints: 4200n,
    });
  });

  it("drafts 1A $250, 1B $105 and net GST $145", () => {
    expect(
      draftBasSummary({
        sales: [invoice],
        creditableGst: all.map((cost) => cost.creditableGst),
      }),
    ).toEqual({
      g1: 275000n,
      gstOnSales: 25000n,
      gstCredits: 10500n,
      netGst: 14500n,
    });
  });

  it("leaves $1,750 and $590 outstanding after settlements; profit unchanged", () => {
    expect(
      outstanding({ charged: [invoice.inclusive], settled: [100000n] }),
    ).toBe(175000n);
    expect(
      outstanding({
        charged: [costs.subcontractor.inclusive],
        settled: [40000n],
      }),
    ).toBe(59000n);
    expect(profitOf(invoice.exclusive, all).profit).toBe(105000n);
  });

  it("non-creditable materials GST becomes cost: $1,465 cost, $1,035 profit, 1B $90", () => {
    const variant = Object.values(
      registeredCosts({ numerator: 0n, denominator: 1n }),
    );
    const result = profitOf(invoice.exclusive, variant);
    expect(result.cost).toBe(146500n);
    expect(result.profit).toBe(103500n);
    const bas = draftBasSummary({
      sales: [invoice],
      creditableGst: variant.map((c) => c.creditableGst),
    });
    expect(bas.gstCredits).toBe(9000n);
    expect(bas.netGst).toBe(16000n);
  });

  it("missing evidence defers the credit, so the GST is provisionally cost (R6)", () => {
    const deferred = calculatePurchase({
      exclusive: 15000n,
      gst: 1500n,
      buyerRegistered: true,
      hasEvidence: false,
    });
    expect(deferred).toMatchObject({
      creditableGst: 0n,
      nonCreditableGst: 1500n,
      jobCost: 16500n,
    });
  });

  it("50% creditable materials: cost $1,457.50, profit $1,042.50, 1B $97.50, net $152.50", () => {
    const variant = Object.values(
      registeredCosts({ numerator: 1n, denominator: 2n }),
    );
    const result = profitOf(invoice.exclusive, variant);
    expect(result.cost).toBe(145750n);
    expect(result.profit).toBe(104250n);
    const bas = draftBasSummary({
      sales: [invoice],
      creditableGst: variant.map((c) => c.creditableGst),
    });
    expect(bas.gstCredits).toBe(9750n);
    expect(bas.netGst).toBe(15250n);
  });
});

describe("cash basis attribution (R7)", () => {
  it("attributes 9091 to the $1,000 receipt and 3636 to the $400 payment: net 5455", () => {
    const sales = cashAttributedGst({
      documentTotal: 275000n,
      documentGst: 25000n,
      previouslySettled: 0n,
      settlement: 100000n,
    });
    const credits = cashAttributedGst({
      documentTotal: 99000n,
      documentGst: 9000n,
      previouslySettled: 0n,
      settlement: 40000n,
    });
    expect([sales, credits]).toEqual([9091n, 3636n]);
    expect(
      draftBasSummary({
        sales: [{ taxCode: "TAXABLE_10", inclusive: 100000n, gst: sales }],
        creditableGst: [credits],
      }).netGst,
    ).toBe(5455n);
    // Profit is unaffected by when GST is attributed.
    expect(profitOf(250000n, Object.values(registeredCosts())).profit).toBe(
      105000n,
    );
  });

  it("releases the exact residual on final settlement: 15909, cumulative 25000 (never 25001)", () => {
    const first = cashAttributedGst({
      documentTotal: 275000n,
      documentGst: 25000n,
      previouslySettled: 0n,
      settlement: 100000n,
    });
    const second = cashAttributedGst({
      documentTotal: 275000n,
      documentGst: 25000n,
      previouslySettled: 100000n,
      settlement: 175000n,
    });
    expect(second).toBe(15909n);
    expect(first + second).toBe(25000n);
  });

  it("mixed invoice: a pro-rata $105 receipt attributes $5.00 GST, not 1/11 ($9.55)", () => {
    const lines = [
      calculateSupplyLine({
        quantity: "1",
        unitPrice: 11000n,
        priceEntry: "inclusive",
        taxCode: "TAXABLE_10",
        supplierRegistered: true,
      }),
      calculateSupplyLine({
        quantity: "1",
        unitPrice: 10000n,
        priceEntry: "inclusive",
        taxCode: "GST_FREE",
        supplierRegistered: true,
      }),
    ];
    const totals = documentTotals(lines);
    expect(totals).toEqual({
      exclusive: 20000n,
      gst: 1000n,
      inclusive: 21000n,
    });
    const [taxablePart] = allocateProRata(
      10500n,
      lines.map((line) => line.inclusive),
    );
    expect(taxablePart).toBe(5500n);
    expect(
      cashAttributedGst({
        documentTotal: 11000n,
        documentGst: 1000n,
        previouslySettled: 0n,
        settlement: taxablePart ?? 0n,
      }),
    ).toBe(500n);
    expect(
      cashAttributedGst({
        documentTotal: totals.inclusive,
        documentGst: totals.gst,
        previouslySettled: 0n,
        settlement: 10500n,
      }),
    ).toBe(500n);
  });
});

describe("rounding and corrections (R3, R9)", () => {
  const line = (unitPrice: bigint, priceEntry: "exclusive" | "inclusive") =>
    calculateSupplyLine({
      quantity: "1",
      unitPrice,
      priceEntry,
      taxCode: "TAXABLE_10",
      supplierRegistered: true,
    });

  it("rounds a half cent up per line: ex 5 → GST 1, total 6", () => {
    expect(line(5n, "exclusive")).toMatchObject({ gst: 1n, inclusive: 6n });
  });

  it("sums rounded lines, never re-rounds the invoice: 1 + 1 = 2, total 12", () => {
    expect(
      documentTotals([line(5n, "exclusive"), line(5n, "exclusive")]),
    ).toEqual({
      exclusive: 10n,
      gst: 2n,
      inclusive: 12n,
    });
  });

  it("inclusive entry: 100 → GST 9, ex 91", () => {
    expect(line(100n, "inclusive")).toMatchObject({
      exclusive: 91n,
      gst: 9n,
      inclusive: 100n,
    });
  });

  it("a full credit note reverses revenue and GST exactly once", () => {
    const original = sale(true);
    const credit = reverseLine(original);
    expect(credit).toMatchObject({
      exclusive: -250000n,
      gst: -25000n,
      inclusive: -275000n,
    });
    expect(documentTotals([original, credit])).toEqual({
      exclusive: 0n,
      gst: 0n,
      inclusive: 0n,
    });
    expect(
      outstanding({
        charged: [original.inclusive],
        credited: [-credit.inclusive],
      }),
    ).toBe(0n);
    expect(
      jobProfit({
        revenueExclusive: [original.exclusive, credit.exclusive],
        jobCosts: [],
      }).marginBasisPoints,
    ).toBeNull();
  });
});
