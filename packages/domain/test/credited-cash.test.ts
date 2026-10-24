import { describe, expect, it } from "vitest";
import { adjustedCashShare } from "../src/index";

describe("cash attribution after credits (#55)", () => {
  const base = {
    total: 160000n,
    eligible: 10000n,
    credited: 50000n,
    creditedEligible: 0n,
    received: 110000n,
  };
  it("attributes the taxable supply after an out-of-scope credit", () => {
    expect(adjustedCashShare(base)).toBe(10000n);
    expect(adjustedCashShare({ ...base, received: 80000n })).toBe(7273n);
    expect(adjustedCashShare({ ...base, eligible: 110000n })).toBe(110000n);
  });
  it("retains the refunded component until consideration is returned", () => {
    const credited = {
      total: 110000n,
      eligible: 10000n,
      credited: 110000n,
      creditedEligible: 10000n,
      received: 110000n,
    };
    expect(adjustedCashShare(credited)).toBe(10000n);
    expect(adjustedCashShare({ ...credited, received: 55000n })).toBe(5000n);
    expect(adjustedCashShare({ ...credited, received: 0n })).toBe(0n);
    expect(
      adjustedCashShare({
        ...credited,
        credited: 55000n,
        creditedEligible: 5000n,
        received: 82500n,
      }),
    ).toBe(7500n);
    expect(
      adjustedCashShare({
        ...credited,
        credited: 0n,
        creditedEligible: 0n,
        received: 55000n,
      }),
    ).toBe(5000n);
  });
  it("rejects inconsistent tax components and settlement bounds", () => {
    for (const invalid of [
      { total: 0n },
      { credited: -1n },
      { credited: 160001n },
      { eligible: -1n },
      { eligible: 160001n },
      { creditedEligible: -1n },
      { creditedEligible: 10001n },
      { credited: 0n, creditedEligible: 1n },
      { credited: 159999n },
      { received: -1n },
      { received: 160001n },
    ])
      expect(() => adjustedCashShare({ ...base, ...invalid })).toThrow(
        RangeError,
      );
  });
});
