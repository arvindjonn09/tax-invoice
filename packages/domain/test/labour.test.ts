// #38 Labour cost from effective-dated rates, asserted with job profit on the
// combined fixture (labour 30000, no GST). Cents throughout.
import { describe, expect, it } from "vitest";
import {
  MAX_TIMESHEET_MINUTES,
  calculatePurchase,
  internalCost,
  jobProfit,
  labourCost,
  rateOn,
} from "../src/index";

const history = [
  { effectiveFrom: "2026-07-01", hourlyCost: 5000n },
  { effectiveFrom: "2026-01-01", hourlyCost: 4000n },
  { effectiveFrom: "2026-09-01", hourlyCost: 6000n },
];

describe("rateOn", () => {
  it("picks the latest rate starting on or before the date, in any order", () => {
    expect(rateOn(history, "2025-12-31")).toBeNull();
    expect(rateOn(history, "2026-01-01")?.hourlyCost).toBe(4000n);
    expect(rateOn(history, "2026-06-30")?.hourlyCost).toBe(4000n);
    expect(rateOn(history, "2026-07-01")?.hourlyCost).toBe(5000n);
    expect(rateOn(history, "2026-12-31")?.hourlyCost).toBe(6000n);
    expect(rateOn([], "2026-07-01")).toBeNull();
    expect(() => rateOn(history, "2026-02-30")).toThrow();
  });
});

describe("labourCost", () => {
  it("rounds minutes × rate / 60 once, to the cent", () => {
    expect(labourCost(60, 5000n)).toBe(5000n);
    expect(labourCost(90, 5000n)).toBe(7500n);
    // 7 min at $33.33/h = 388.85 → 389 cents.
    expect(labourCost(7, 3333n)).toBe(389n);
    expect(labourCost(1, 0n)).toBe(0n);
    expect(labourCost(MAX_TIMESHEET_MINUTES, 1_000_000n)).toBe(24_000_000n);
  });

  it("refuses zero, fractional or over-a-day minutes and negative rates", () => {
    for (const minutes of [0, -1, 1.5, MAX_TIMESHEET_MINUTES + 1])
      expect(() => labourCost(minutes, 5000n), String(minutes)).toThrow();
    expect(() => labourCost(60, -1n)).toThrow();
  });

  it("a later rate change leaves an earlier snapshot alone", () => {
    const snapshot = labourCost(360, rateOn(history, "2026-07-02")!.hourlyCost);
    const changed = [
      ...history,
      { effectiveFrom: "2026-07-02", hourlyCost: 9000n },
    ];
    expect(snapshot).toBe(30000n);
    expect(labourCost(360, rateOn(changed, "2026-07-02")!.hourlyCost)).toBe(
      54000n,
    );
    expect(snapshot).toBe(30000n);
  });
});

describe("combined fixture: 6 h at $50 is the 30000 labour line", () => {
  it("cost 145000, profit 105000, 42%", () => {
    const labour = internalCost(labourCost(360, 5000n));
    expect(labour).toMatchObject({
      gst: 0n,
      creditableGst: 0n,
      jobCost: 30000n,
    });
    const subcontractor = calculatePurchase({
      exclusive: 90000n,
      gst: 9000n,
      buyerRegistered: true,
      hasEvidence: true,
    }).jobCost;
    const materials = calculatePurchase({
      exclusive: 15000n,
      gst: 1500n,
      buyerRegistered: true,
      hasEvidence: true,
    }).jobCost;
    expect(
      jobProfit({
        revenueExclusive: [250000n],
        jobCosts: [subcontractor, labour.jobCost, materials, 10000n],
      }),
    ).toEqual({
      revenue: 250000n,
      cost: 145000n,
      profit: 105000n,
      marginBasisPoints: 4200n,
    });
  });
});
