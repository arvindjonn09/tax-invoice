// #35 Contractor offers and committed cost, asserted together with job profit
// on the combined fixture (docs/GST.md#combined-gst-and-profit-acceptance-fixture):
// the subcontractor's 90000 ex GST is committed once on acceptance and is not
// counted again when its bill arrives. All amounts are cents.
import { describe, expect, it } from "vitest";
import {
  calculatePurchase,
  committedJobCost,
  hoursQuantity,
  internalCost,
  jobCostExposure,
  jobProfit,
  offerLine,
  outstandingCommitment,
} from "../src/index";

const fixed = (registered: boolean) =>
  offerLine({
    rateType: "fixed",
    rateExclusive: 90000n,
    estimatedHoursHundredths: null,
    taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
    contractorRegistered: registered,
  });

describe("offer amounts", () => {
  it("prices a fixed offer as one GST line", () => {
    expect(fixed(true)).toEqual({
      taxCode: "TAXABLE_10",
      rateBasisPoints: 1000n,
      exclusive: 90000n,
      gst: 9000n,
      inclusive: 99000n,
    });
    expect(fixed(false)).toMatchObject({ gst: 0n, inclusive: 90000n });
  });

  it("prices an hourly offer as estimated hours × rate, rounding GST per line", () => {
    const line = offerLine({
      rateType: "hourly",
      rateExclusive: 8333n,
      estimatedHoursHundredths: 750n,
      taxCode: "TAXABLE_10",
      contractorRegistered: true,
    });
    // 7.5 × 83.33 = 624.975 → 62498 cents; GST 6249.8 → 6250.
    expect(line).toMatchObject({
      exclusive: 62498n,
      gst: 6250n,
      inclusive: 68748n,
    });
    expect(hoursQuantity(750n)).toBe("7.50");
    expect(hoursQuantity(805n)).toBe("8.05");
    expect(hoursQuantity(800n)).toBe("8");
  });

  it("refuses GST from an unregistered contractor and inconsistent terms", () => {
    expect(() =>
      offerLine({
        rateType: "fixed",
        rateExclusive: 100n,
        estimatedHoursHundredths: null,
        taxCode: "TAXABLE_10",
        contractorRegistered: false,
      }),
    ).toThrow(/not registered/);
    expect(() =>
      offerLine({
        rateType: "hourly",
        rateExclusive: 100n,
        estimatedHoursHundredths: null,
        taxCode: "GST_FREE",
        contractorRegistered: true,
      }),
    ).toThrow(/estimated hours/);
    expect(() =>
      offerLine({
        rateType: "fixed",
        rateExclusive: 100n,
        estimatedHoursHundredths: 100n,
        taxCode: "GST_FREE",
        contractorRegistered: true,
      }),
    ).toThrow(/no estimated hours/);
    expect(() => hoursQuantity(0n)).toThrow();
    expect(() =>
      offerLine({
        rateType: "fixed",
        rateExclusive: -1n,
        estimatedHoursHundredths: null,
        taxCode: "GST_FREE",
        contractorRegistered: true,
      }),
    ).toThrow(/>= 0/);
  });
});

describe("committed cost", () => {
  it("commits GST-exclusive cost for a registered company (GST is recoverable)", () => {
    expect(committedJobCost(fixed(true), true)).toBe(90000n);
  });

  it("commits GST-inclusive cost when the company can't claim the GST", () => {
    expect(committedJobCost(fixed(true), false)).toBe(99000n);
  });

  it("never goes below zero after linked bills", () => {
    expect(outstandingCommitment({ committed: 90000n, billed: [] })).toBe(
      90000n,
    );
    expect(outstandingCommitment({ committed: 90000n, billed: [40000n] })).toBe(
      50000n,
    );
    expect(outstandingCommitment({ committed: 90000n, billed: [95000n] })).toBe(
      0n,
    );
  });
});

describe("combined fixture: commitment then bill, counted once", () => {
  const revenue = [250000n];
  const labour = internalCost(30000n).jobCost;
  const materials = calculatePurchase({
    exclusive: 15000n,
    gst: 1500n,
    buyerRegistered: true,
    hasEvidence: true,
  }).jobCost;
  const travel = internalCost(10000n).jobCost;
  const committed = committedJobCost(fixed(true), true);

  it("before the bill: forecast includes the commitment, profit does not", () => {
    const exposure = jobCostExposure({
      incurred: [labour, materials, travel],
      commitments: [{ committed, billed: [] }],
    });
    expect(exposure).toEqual({
      incurred: 55000n,
      committed: 90000n,
      total: 145000n,
    });
    expect(
      jobProfit({
        revenueExclusive: revenue,
        jobCosts: [labour, materials, travel],
      }).profit,
    ).toBe(195000n);
  });

  it("after the bill: 145000 cost, 105000 profit, 42% — not 235000 cost", () => {
    const bill = calculatePurchase({
      exclusive: 90000n,
      gst: 9000n,
      buyerRegistered: true,
      hasEvidence: true,
    });
    const incurred = [bill.jobCost, labour, materials, travel];
    const exposure = jobCostExposure({
      incurred,
      commitments: [{ committed, billed: [bill.jobCost] }],
    });
    expect(exposure).toEqual({
      incurred: 145000n,
      committed: 0n,
      total: 145000n,
    });
    expect(
      jobProfit({ revenueExclusive: revenue, jobCosts: incurred }),
    ).toEqual({
      revenue: 250000n,
      cost: 145000n,
      profit: 105000n,
      marginBasisPoints: 4200n,
    });
    // Recoverable GST stays out of cost: 1B credit is 9000 + 1500, not expense.
    expect(bill.creditableGst).toBe(9000n);
  });

  it("unregistered variant: same 145000 cost and 105000 profit", () => {
    const unregistered = committedJobCost(fixed(false), false);
    expect(unregistered).toBe(90000n);
    const exposure = jobCostExposure({
      incurred: [90000n, 30000n, 15000n, 10000n],
      commitments: [{ committed: unregistered, billed: [90000n] }],
    });
    expect(exposure.total).toBe(145000n);
  });
});
