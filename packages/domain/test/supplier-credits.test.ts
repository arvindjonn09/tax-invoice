import { describe, expect, it } from "vitest";
import {
  type CreditableBill,
  NOTHING_CREDITED,
  type GstLine,
  billLine,
  creditAmounts,
  creditCashAdjustment,
  creditProblem,
} from "../src/index";

// The fixture's subcontractor bill: $900 + $90 GST, valid tax invoice.
const BILL: CreditableBill = {
  exclusive: 90_000n,
  gst: 9_000n,
  inclusive: 99_000n,
  creditableGst: 9_000n,
  companyRegistered: true,
  hasEvidence: true,
  creditableBasisPoints: 10_000n,
};
const taxable = (exclusive: bigint, gst: bigint): GstLine =>
  billLine({ taxCode: "TAXABLE_10", exclusive, gst });
const free = (exclusive: bigint): GstLine =>
  billLine({ taxCode: "GST_FREE", exclusive, gst: 0n });

describe("supplier credits (#140)", () => {
  it("credits $100 + $10 of the fixture bill: cost, claim and owing all fall", () => {
    const lines = [taxable(10_000n, 1_000n)];
    expect(creditProblem(lines, BILL, NOTHING_CREDITED, 0n)).toBeNull();
    expect(creditAmounts(lines, BILL, NOTHING_CREDITED)).toEqual({
      exclusive: 10_000n,
      gst: 1_000n,
      inclusive: 11_000n,
      creditableGst: 1_000n,
      nonCreditableGst: 0n,
      jobCost: 10_000n,
    });
  });

  it("refuses an empty or zero credit", () => {
    expect(creditProblem([], BILL, NOTHING_CREDITED, 0n)).toMatch(
      /more than \$0/,
    );
    expect(creditProblem([free(0n)], BILL, NOTHING_CREDITED, 0n)).toMatch(
      /more than \$0/,
    );
  });

  it("never credits beyond the bill's exclusive amount, GST or what's owing", () => {
    expect(creditProblem([free(90_001n)], BILL, NOTHING_CREDITED, 0n)).toMatch(
      /ex-GST/,
    );
    // GST beyond the bill's GST (e.g. a taxable credit on a mostly GST-free bill).
    const credited = { ...NOTHING_CREDITED, gst: 8_500n, inclusive: 8_500n };
    expect(
      creditProblem([taxable(10_000n, 1_000n)], BILL, credited, 0n),
    ).toMatch(/more GST/);
    // $400 paid: at most $590 can still be credited.
    expect(
      creditProblem(
        [taxable(53_637n, 5_364n)],
        BILL,
        NOTHING_CREDITED,
        40_000n,
      ),
    ).toMatch(/still owing/);
    expect(
      creditProblem(
        [taxable(53_636n, 5_364n)],
        BILL,
        NOTHING_CREDITED,
        40_000n,
      ),
    ).toBeNull();
  });

  it("keeps the bill's creditable share; the unclaimable rest comes off cost", () => {
    const half = {
      ...BILL,
      creditableGst: 4_500n,
      creditableBasisPoints: 5_000n,
    };
    const first = creditAmounts(
      [taxable(10_000n, 1_001n)],
      half,
      NOTHING_CREDITED,
    );
    expect(first).toMatchObject({
      creditableGst: 501n,
      nonCreditableGst: 500n,
      jobCost: 10_500n,
    });
    // Cumulative rounding: a second credit lands the total on the exact share.
    const second = creditAmounts([taxable(10_000n, 1_001n)], half, {
      exclusive: 10_000n,
      gst: 1_001n,
      inclusive: 11_001n,
      creditableGst: 501n,
    });
    expect(second.creditableGst).toBe(500n); // round(2002 / 2) − 501
    // Not claimable at all (no evidence, or unregistered): all GST is cost.
    for (const bill of [
      { ...BILL, hasEvidence: false, creditableGst: 0n },
      { ...BILL, companyRegistered: false, creditableGst: 0n },
    ])
      expect(
        creditAmounts([taxable(10_000n, 1_000n)], bill, NOTHING_CREDITED),
      ).toMatchObject({
        creditableGst: 0n,
        nonCreditableGst: 1_000n,
        jobCost: 11_000n,
      });
  });

  it("clamps the claim reduction to the credit's own GST and never below zero", () => {
    // Earlier live credits already took more than the cumulative share
    // (possible after a middle credit is voided): reduce by nothing.
    expect(
      creditAmounts([taxable(1_000n, 100n)], BILL, {
        exclusive: 1_000n,
        gst: 100n,
        inclusive: 1_100n,
        creditableGst: 300n,
      }).creditableGst,
    ).toBe(0n);
    // And never more than this credit's GST.
    expect(
      creditAmounts([taxable(1_000n, 100n)], BILL, {
        exclusive: 1_000n,
        gst: 100n,
        inclusive: 1_100n,
        creditableGst: 0n,
      }).creditableGst,
    ).toBe(100n);
  });

  it("re-bases cash-basis credit on the net bill", () => {
    // $400 paid of $990 attributed round(400 × 90 / 990) = 3636. A $110
    // credit makes the bill $880 with $80 claimable: 400 × 80 / 880 = 3636.36.
    expect(
      creditCashAdjustment({
        netInclusive: 88_000n,
        netCreditableGst: 8_000n,
        paid: 40_000n,
        attributed: 3_636n,
      }),
    ).toBe(0n);
    // Fully paid after the credit: exactly the net claim is attributed.
    expect(
      creditCashAdjustment({
        netInclusive: 88_000n,
        netCreditableGst: 8_000n,
        paid: 88_000n,
        attributed: 9_000n,
      }),
    ).toBe(-1_000n);
    // Credited to nothing with nothing paid: nothing stays attributed.
    expect(
      creditCashAdjustment({
        netInclusive: 0n,
        netCreditableGst: 0n,
        paid: 0n,
        attributed: 0n,
      }),
    ).toBe(0n);
  });
});
