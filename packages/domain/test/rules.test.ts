// Unit, boundary and property-based tests for the money/GST/profit core.
// Properties use a seeded PRNG so every run checks the same cases.
import { describe, expect, it } from "vitest";
import {
  TAX_CODES,
  allocateProRata,
  calculatePurchase,
  calculateSupplyLine,
  cashAttributedGst,
  cumulativeCashGst,
  divideRounded,
  draftBasSummary,
  gstRateBasisPoints,
  internalCost,
  jobProfit,
  lineAmount,
  multiplyByFraction,
  nonCashAttributionDate,
  outstanding,
  parseQuantity,
  toCents,
} from "../src/index";

/** mulberry32: small deterministic PRNG for property tests. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (max: number) => BigInt(Math.floor(next() * max));
}

describe("money", () => {
  it("accepts only safe integer cents", () => {
    expect(toCents(250000)).toBe(250000n);
    expect(toCents(-5n)).toBe(-5n);
    for (const bad of [
      0.1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => toCents(bad)).toThrow(RangeError);
    }
  });

  it("rounds halves away from zero and rejects bad denominators", () => {
    expect(divideRounded(5n, 10n)).toBe(1n);
    expect(divideRounded(4n, 10n)).toBe(0n);
    expect(divideRounded(-5n, 10n)).toBe(-1n);
    expect(divideRounded(-4n, 10n)).toBe(0n);
    expect(() => divideRounded(1n, 0n)).toThrow(RangeError);
    expect(() => divideRounded(1n, -1n)).toThrow(RangeError);
  });

  it("multiplies by a validated fraction", () => {
    expect(multiplyByFraction(1500n, { numerator: 1n, denominator: 2n })).toBe(
      750n,
    );
    expect(multiplyByFraction(1001n, { numerator: 1n, denominator: 2n })).toBe(
      501n,
    );
    for (const bad of [
      { numerator: 1n, denominator: 0n },
      { numerator: -1n, denominator: 2n },
      { numerator: 3n, denominator: 2n },
    ]) {
      expect(() => multiplyByFraction(100n, bad)).toThrow(RangeError);
    }
  });

  it("allocates pro rata exactly, ties to the earlier line", () => {
    expect(allocateProRata(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(allocateProRata(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocateProRata(7n, [0n, 3n])).toEqual([0n, 7n]);
    expect(() => allocateProRata(-1n, [1n])).toThrow(RangeError);
    expect(() => allocateProRata(1n, [-1n, 2n])).toThrow(RangeError);
    expect(() => allocateProRata(1n, [0n, 0n])).toThrow(RangeError);
  });

  it("property: allocations always sum to the amount and differ from the exact share by < 1 cent", () => {
    const random = seeded(17);
    for (let run = 0; run < 500; run += 1) {
      const amount = random(1_000_000);
      const weights = Array.from({ length: Number(random(5)) + 1 }, () =>
        random(100_000),
      );
      if (!weights.some((weight) => weight > 0n)) weights[0] = 1n;
      const parts = allocateProRata(amount, weights);
      const total = weights.reduce((a, b) => a + b, 0n);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(amount);
      parts.forEach((part, index) => {
        const exactTimesTotal = amount * (weights[index] ?? 0n);
        const diff = part * total - exactTimesTotal;
        expect(diff < total && diff > -total).toBe(true);
      });
    }
  });
});

describe("GST lines", () => {
  it("snapshots the rate for every code; zero-rated codes stay distinct", () => {
    expect(TAX_CODES.map(gstRateBasisPoints)).toEqual([1000n, 0n, 0n, 0n]);
    for (const taxCode of TAX_CODES.slice(1)) {
      for (const priceEntry of ["exclusive", "inclusive"] as const) {
        expect(
          calculateSupplyLine({
            quantity: "2",
            unitPrice: 5000n,
            priceEntry,
            taxCode,
            supplierRegistered: true,
          }),
        ).toEqual({
          taxCode,
          rateBasisPoints: 0n,
          exclusive: 10000n,
          gst: 0n,
          inclusive: 10000n,
        });
      }
    }
  });

  it("an unregistered supplier cannot charge GST but may issue other codes", () => {
    expect(() =>
      calculateSupplyLine({
        quantity: "1",
        unitPrice: 100n,
        priceEntry: "exclusive",
        taxCode: "TAXABLE_10",
        supplierRegistered: false,
      }),
    ).toThrow("not registered");
    expect(
      calculateSupplyLine({
        quantity: "1",
        unitPrice: 100n,
        priceEntry: "exclusive",
        taxCode: "GST_FREE",
        supplierRegistered: false,
      }).gst,
    ).toBe(0n);
  });

  it("aggregates quantity × price before rounding GST", () => {
    expect(lineAmount("1.5", 3333n)).toBe(5000n); // 4999.5 → 5000
    expect(lineAmount("0.0001", 10000n)).toBe(1n);
    expect(parseQuantity("12.25")).toEqual({ units: 1225n, scale: 100n });
    for (const bad of ["0", "0.0", "-1", "1.23456", "1e3", "", "abc", "1."]) {
      expect(() => parseQuantity(bad)).toThrow(RangeError);
    }
  });

  it("property: ex/incl entry always satisfy exclusive + gst = inclusive and gst ≈ 10%", () => {
    const random = seeded(10);
    for (let run = 0; run < 2000; run += 1) {
      const unitPrice = random(10_000_000);
      for (const priceEntry of ["exclusive", "inclusive"] as const) {
        const line = calculateSupplyLine({
          quantity: "1",
          unitPrice,
          priceEntry,
          taxCode: "TAXABLE_10",
          supplierRegistered: true,
        });
        expect(line.exclusive + line.gst).toBe(line.inclusive);
        // |gst × 10 − exclusive| ≤ 10 (rounding is within half a cent of GST).
        const error = line.gst * 10n - line.exclusive;
        expect(error <= 10n && error >= -10n).toBe(true);
      }
    }
  });
});

describe("purchases and profit", () => {
  it("rejects negative purchase and internal amounts", () => {
    expect(() =>
      calculatePurchase({
        exclusive: -1n,
        gst: 0n,
        buyerRegistered: true,
        hasEvidence: true,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculatePurchase({
        exclusive: 1n,
        gst: -1n,
        buyerRegistered: true,
        hasEvidence: true,
      }),
    ).toThrow(RangeError);
    expect(() => internalCost(-1n)).toThrow(RangeError);
  });

  it("margin is N/A at zero revenue and computed on GST-exclusive revenue", () => {
    expect(jobProfit({ revenueExclusive: [], jobCosts: [100n] })).toEqual({
      revenue: 0n,
      cost: 100n,
      profit: -100n,
      marginBasisPoints: null,
    });
    expect(
      jobProfit({ revenueExclusive: [3n], jobCosts: [1n] }).marginBasisPoints,
    ).toBe(6667n);
  });

  it("property: recoverable GST never changes profit", () => {
    const random = seeded(42);
    for (let run = 0; run < 1000; run += 1) {
      const revenue = random(5_000_000);
      const exclusive = random(1_000_000);
      const withGst = calculatePurchase({
        exclusive,
        gst: random(100_000),
        buyerRegistered: true,
        hasEvidence: true,
      });
      const withoutGst = calculatePurchase({
        exclusive,
        gst: 0n,
        buyerRegistered: true,
        hasEvidence: true,
      });
      const sales = calculateSupplyLine({
        quantity: "1",
        unitPrice: revenue,
        priceEntry: "exclusive",
        taxCode: "TAXABLE_10",
        supplierRegistered: true,
      });
      expect(
        jobProfit({
          revenueExclusive: [sales.exclusive],
          jobCosts: [withGst.jobCost],
        }),
      ).toEqual(
        jobProfit({
          revenueExclusive: [revenue],
          jobCosts: [withoutGst.jobCost],
        }),
      );
    }
  });

  it("property: creditable + non-creditable GST always equals the supplier's GST", () => {
    const random = seeded(7);
    for (let run = 0; run < 1000; run += 1) {
      const denominator = random(100) + 1n;
      const purchase = calculatePurchase({
        exclusive: random(1_000_000),
        gst: random(100_000),
        buyerRegistered: true,
        hasEvidence: true,
        creditableFraction: {
          numerator: random(Number(denominator) + 1),
          denominator,
        },
      });
      expect(purchase.creditableGst + purchase.nonCreditableGst).toBe(
        purchase.gst,
      );
      expect(purchase.jobCost).toBe(
        purchase.exclusive + purchase.nonCreditableGst,
      );
    }
  });
});

describe("balances and attribution", () => {
  it("rejects over-allocation and negative inputs", () => {
    expect(outstanding({ charged: [100n] })).toBe(100n);
    expect(() => outstanding({ charged: [100n], settled: [101n] })).toThrow(
      "exceed",
    );
    expect(() =>
      outstanding({ charged: [100n], credited: [60n], settled: [50n] }),
    ).toThrow("exceed");
    expect(() => outstanding({ charged: [-1n] })).toThrow(RangeError);
  });

  it("property: payments never change profit; balances fall by exactly the payment", () => {
    const random = seeded(3);
    for (let run = 0; run < 500; run += 1) {
      const total = random(1_000_000) + 1n;
      const paid = random(Number(total) + 1);
      const before = jobProfit({
        revenueExclusive: [total],
        jobCosts: [total / 2n],
      });
      expect(outstanding({ charged: [total], settled: [paid] })).toBe(
        total - paid,
      );
      expect(
        jobProfit({ revenueExclusive: [total], jobCosts: [total / 2n] }),
      ).toEqual(before);
    }
  });

  it("property: cash attribution over any settlement sequence totals the document GST", () => {
    const random = seeded(99);
    for (let run = 0; run < 500; run += 1) {
      const documentTotal = random(1_000_000) + 1n;
      const documentGst = random(Number(documentTotal) + 1);
      let settled = 0n;
      let attributed = 0n;
      while (settled < documentTotal) {
        const remaining = documentTotal - settled;
        const settlement = random(Number(remaining)) + 1n;
        const share = cashAttributedGst({
          documentTotal,
          documentGst,
          previouslySettled: settled,
          settlement,
        });
        expect(share >= 0n).toBe(true);
        attributed += share;
        settled += settlement;
        expect(attributed <= documentGst).toBe(true);
      }
      expect(attributed).toBe(documentGst);
    }
  });

  it("validates cash attribution inputs", () => {
    const base = {
      documentTotal: 100n,
      documentGst: 10n,
      previouslySettled: 0n,
      settlement: 10n,
    };
    expect(() => cashAttributedGst({ ...base, documentTotal: 0n })).toThrow(
      RangeError,
    );
    expect(() => cashAttributedGst({ ...base, documentGst: -1n })).toThrow(
      RangeError,
    );
    expect(() => cashAttributedGst({ ...base, documentGst: 101n })).toThrow(
      RangeError,
    );
    expect(() => cashAttributedGst({ ...base, settlement: -1n })).toThrow(
      RangeError,
    );
    expect(() =>
      cashAttributedGst({ ...base, previouslySettled: -1n }),
    ).toThrow(RangeError);
    expect(() =>
      cashAttributedGst({ ...base, previouslySettled: 95n }),
    ).toThrow("exceed");
    const cumulative = { documentTotal: 100n, documentGst: 10n };
    expect(() => cumulativeCashGst({ ...cumulative, settled: -1n })).toThrow(
      RangeError,
    );
    expect(() => cumulativeCashGst({ ...cumulative, settled: 101n })).toThrow(
      RangeError,
    );
    expect(() =>
      cumulativeCashGst({ ...cumulative, documentTotal: 0n, settled: 0n }),
    ).toThrow("positive");
    expect(cumulativeCashGst({ ...cumulative, settled: 55n })).toBe(6n);
  });

  it("non-cash attribution uses the earlier of issue and first consideration (R8)", () => {
    expect(nonCashAttributionDate({ invoiceIssuedOn: "2026-10-15" })).toBe(
      "2026-10-15",
    );
    expect(
      nonCashAttributionDate({
        invoiceIssuedOn: "2026-10-15",
        firstConsiderationOn: "2026-09-30",
      }),
    ).toBe("2026-09-30");
    expect(
      nonCashAttributionDate({
        invoiceIssuedOn: "2026-10-15",
        firstConsiderationOn: "2026-11-01",
      }),
    ).toBe("2026-10-15");
    expect(() =>
      nonCashAttributionDate({ invoiceIssuedOn: "15/10/2026" }),
    ).toThrow(RangeError);
  });

  it("G1 excludes out-of-scope amounts; net GST may be a refund", () => {
    expect(
      draftBasSummary({
        sales: [
          { taxCode: "GST_FREE", inclusive: 5000n, gst: 0n },
          { taxCode: "OUT_OF_SCOPE", inclusive: 3000n, gst: 0n },
        ],
        creditableGst: [200n],
      }),
    ).toEqual({ g1: 5000n, gstOnSales: 0n, gstCredits: 200n, netGst: -200n });
  });
});
