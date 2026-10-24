import { describe, expect, it } from "vitest";
import {
  type BillBalance,
  billCost,
  billEvidenceReclass,
  billLine,
  billLineProblem,
  billOutstanding,
  jobCostExposure,
  jobProfit,
  outstandingCommitment,
  paymentCreditableGst,
  paymentVoidAdjustment,
  paymentProblems,
} from "../src/index";

const balance = (overrides: Partial<BillBalance> = {}): BillBalance => ({
  billId: "bill-1",
  inclusive: 99_000n,
  creditableGst: 9_000n,
  paid: 0n,
  attributed: 0n,
  ...overrides,
});
const balances = (...list: BillBalance[]) =>
  new Map(list.map((row) => [row.billId, row]));

const subcontractor = [
  billLine({ taxCode: "TAXABLE_10", exclusive: 90_000n, gst: 9_000n }),
];
const evidence = {
  document: "tax_invoice" as const,
  evidenceVerified: true,
  creditableBasisPoints: 10_000n,
};

describe("supplier bills (#46)", () => {
  it("combined fixture, registered: $990 bill costs $900; $400 paid leaves $590; profit unchanged", () => {
    const cost = billCost(subcontractor, {
      ...evidence,
      companyRegistered: true,
    });
    expect(cost).toMatchObject({
      exclusive: 90_000n,
      gst: 9_000n,
      inclusive: 99_000n,
      creditableGst: 9_000n,
      nonCreditableGst: 0n,
      jobCost: 90_000n,
      hasEvidence: true,
    });
    const before = balance();
    expect(
      paymentProblems(
        40_000n,
        [{ billId: "bill-1", amount: 40_000n }],
        balances(before),
      ),
    ).toEqual([]);
    const after = { ...before, paid: 40_000n };
    expect(billOutstanding(after)).toBe(59_000n);
    // docs/GST.md fixture: revenue $2,500 ex GST; costs 900+300+150+100.
    const profit = () =>
      jobProfit({
        revenueExclusive: [250_000n],
        jobCosts: [cost.jobCost, 30_000n, 15_000n, 10_000n],
      });
    expect(profit()).toMatchObject({
      cost: 145_000n,
      profit: 105_000n,
      marginBasisPoints: 4_200n,
    });
    // Payment changes the balance only; cost and profit are recorded once.
    expect(billOutstanding(before) - billOutstanding(after)).toBe(40_000n);
    expect(profit().profit).toBe(105_000n);
  });

  it("combined fixture, not registered: no GST charged; $400 of $900 leaves $500", () => {
    const line = billLine({
      taxCode: "OUT_OF_SCOPE",
      exclusive: 90_000n,
      gst: 0n,
    });
    expect(billLineProblem(line, false)).toBeNull();
    const cost = billCost([line], { ...evidence, companyRegistered: false });
    expect(cost.jobCost).toBe(90_000n);
    expect(cost.creditableGst).toBe(0n);
    const paid = balance({
      inclusive: 90_000n,
      creditableGst: 0n,
      paid: 40_000n,
    });
    expect(billOutstanding(paid)).toBe(50_000n);
  });

  it("GST on a bill is not automatically creditable", () => {
    // No evidence, unverified evidence, or a company not registered on the
    // bill date: the GST is cost (R5, R6).
    for (const input of [
      { ...evidence, document: null, companyRegistered: true },
      { ...evidence, evidenceVerified: false, companyRegistered: true },
      { ...evidence, companyRegistered: false },
      // A receipt isn't enough above the 8250-cent low-value threshold.
      { ...evidence, document: "receipt" as const, companyRegistered: true },
    ])
      expect(billCost(subcontractor, input)).toMatchObject({
        creditableGst: 0n,
        nonCreditableGst: 9_000n,
        jobCost: 99_000n,
      });
    // Partial business use: half the GST is claimable, half is cost.
    expect(
      billCost(subcontractor, {
        ...evidence,
        companyRegistered: true,
        creditableBasisPoints: 5_000n,
      }),
    ).toMatchObject({
      creditableGst: 4_500n,
      nonCreditableGst: 4_500n,
      jobCost: 94_500n,
    });
    expect(() =>
      billCost(subcontractor, {
        ...evidence,
        companyRegistered: true,
        creditableBasisPoints: 10_001n,
      }),
    ).toThrow(RangeError);
  });

  it("keeps the supplier's GST within a cent of 10%, only on taxable lines from registered suppliers", () => {
    const taxable = (exclusive: bigint, gst: bigint) =>
      billLineProblem({ taxCode: "TAXABLE_10", exclusive, gst }, true);
    expect(taxable(90_000n, 9_000n)).toBeNull();
    // Supplier rounding: 10.05 → 1.00 or 1.01 are both accepted as issued.
    expect(taxable(1_005n, 100n)).toBeNull();
    expect(taxable(1_005n, 101n)).toBeNull();
    expect(taxable(90_000n, 9_002n)).toMatch(/10%/);
    expect(taxable(90_000n, 8_998n)).toMatch(/10%/);
    expect(
      billLineProblem(
        { taxCode: "TAXABLE_10", exclusive: 90_000n, gst: 9_000n },
        false,
      ),
    ).toMatch(/not registered/);
    expect(
      billLineProblem(
        { taxCode: "GST_FREE", exclusive: 90_000n, gst: 1n },
        true,
      ),
    ).toMatch(/Only a taxable line/);
    expect(
      billLineProblem({ taxCode: "GST_FREE", exclusive: -1n, gst: 0n }, true),
    ).toMatch(/negative/);
  });

  it("rejects overpayment, a split that doesn't add up, duplicates and unknown bills", () => {
    const b = balances(
      balance({ paid: 40_000n }),
      balance({ billId: "bill-2", inclusive: 10_000n, creditableGst: 0n }),
    );
    const fields = (
      amount: bigint,
      allocations: { billId: string; amount: bigint }[],
    ) => paymentProblems(amount, allocations, b).map((p) => p.field);
    // $590 owing: paying $590.01 is an overpayment.
    expect(fields(59_001n, [{ billId: "bill-1", amount: 59_001n }])).toEqual([
      "allocations.0",
    ]);
    expect(fields(59_000n, [{ billId: "bill-1", amount: 59_000n }])).toEqual(
      [],
    );
    expect(fields(10_000n, [{ billId: "bill-1", amount: 9_000n }])).toEqual([
      "allocations",
    ]);
    expect(
      fields(20_000n, [
        { billId: "bill-2", amount: 10_000n },
        { billId: "bill-2", amount: 10_000n },
      ]),
    ).toContain("allocations.1");
    expect(fields(100n, [{ billId: "nope", amount: 100n }])).toEqual([
      "allocations.0",
    ]);
    expect(fields(0n, [])).toEqual(["amountCents", "allocations"]);
    expect(fields(100n, [{ billId: "bill-2", amount: 0n }])).toContain(
      "allocations.0",
    );
  });

  it("attributes creditable GST across partial payments exactly once (cash basis)", () => {
    let paid = 0n;
    let attributed = 0n;
    for (const amount of [40_000n, 33_333n, 25_667n]) {
      attributed += paymentCreditableGst(amount, balance({ paid, attributed }));
      paid += amount;
    }
    expect(paid).toBe(99_000n);
    expect(attributed).toBe(9_000n);
    // Non-creditable GST is cost: nothing to attribute.
    expect(paymentCreditableGst(40_000n, balance({ creditableGst: 0n }))).toBe(
      0n,
    );
    // Defensive edges: a zero bill attributes nothing; balances never go
    // negative even if history were inconsistent.
    expect(
      paymentCreditableGst(0n, balance({ inclusive: 0n, creditableGst: 0n })),
    ).toBe(0n);
    expect(billOutstanding(balance({ paid: 100_000n }))).toBe(0n);
  });

  it("voiding a payment corrects the credit at once (adjustment, not edits)", () => {
    // $0.11 bill with $0.01 creditable GST: payments 5c, 1c, 5c → 0, 1, 0.
    const tiny = { inclusive: 11n, creditableGst: 1n };
    const at = (paid: bigint, attributed: bigint) =>
      balance({ ...tiny, paid, attributed });
    expect([
      paymentCreditableGst(5n, at(0n, 0n)),
      paymentCreditableGst(1n, at(5n, 0n)),
      paymentCreditableGst(5n, at(6n, 1n)),
    ]).toEqual([0n, 1n, 0n]);
    // Void the 1c payment: 10c stays paid → round(10/11) = 1c, so +1c.
    expect(paymentVoidAdjustment({ amount: 1n, gst: 1n }, at(11n, 1n))).toBe(
      1n,
    );
    // Its replacement then attributes nothing; the bill ends at 1c.
    expect(paymentCreditableGst(1n, at(10n, 1n))).toBe(0n);
    // Voiding the first 5c leaves 6c paid → round(6/11) = 1c: no adjustment.
    expect(paymentVoidAdjustment({ amount: 5n, gst: 0n }, at(11n, 1n))).toBe(
      0n,
    );
  });

  it("a bill linked to an acceptance releases the commitment, never double counting", () => {
    const commitment = {
      committed: 90_000n,
      committedExclusive: 90_000n,
      billedExclusive: [90_000n],
    };
    expect(outstandingCommitment(commitment)).toBe(0n);
    // Incurred $900 + outstanding commitment $0 = $900 expected, not $1,800.
    expect(
      jobCostExposure({ incurred: [90_000n], commitments: [commitment] }),
    ).toEqual({ incurred: 90_000n, committed: 0n, total: 90_000n });
    const half = { ...commitment, billedExclusive: [45_000n] };
    expect(
      jobCostExposure({ incurred: [45_000n], commitments: [half] }),
    ).toEqual({ incurred: 45_000n, committed: 45_000n, total: 90_000n });
  });
});

describe("late bill evidence (#142, R6)", () => {
  // $900 + $90 GST recorded without evidence: all $90 sat in job cost.
  const recorded = {
    companyRegistered: true,
    document: "tax_invoice" as const,
    creditableBasisPoints: 10_000n,
    recordedCreditableGst: 0n,
    cash: false,
    paid: 0n,
    attributed: 0n,
  };

  it("moves the claimable GST from job cost to credit", () => {
    expect(billEvidenceReclass(subcontractor, recorded)).toEqual({
      creditableGst: 9_000n,
      cashCatchUp: 0n,
    });
    expect(
      billEvidenceReclass(subcontractor, {
        ...recorded,
        creditableBasisPoints: 5_000n,
      }),
    ).toEqual({ creditableGst: 4_500n, cashCatchUp: 0n });
  });

  it("on the cash basis, catches up the credit for what was already paid", () => {
    expect(
      billEvidenceReclass(subcontractor, {
        ...recorded,
        cash: true,
        paid: 49_500n,
      }),
    ).toEqual({ creditableGst: 9_000n, cashCatchUp: 4_500n });
    expect(
      billEvidenceReclass(subcontractor, {
        ...recorded,
        cash: true,
        paid: 99_000n,
      }),
    ).toEqual({ creditableGst: 9_000n, cashCatchUp: 9_000n });
  });

  it("refuses a receipt above $82.50 and bills with nothing claimable", () => {
    expect(
      billEvidenceReclass(subcontractor, { ...recorded, document: "receipt" }),
    ).toHaveProperty("problem", expect.stringMatching(/tax invoice/));
    expect(
      billEvidenceReclass(subcontractor, {
        ...recorded,
        companyRegistered: false,
      }),
    ).toHaveProperty("problem", expect.stringMatching(/nothing to reclassify/));
    expect(
      billEvidenceReclass(subcontractor, {
        ...recorded,
        recordedCreditableGst: 9_000n,
      }),
    ).toHaveProperty("problem", expect.stringMatching(/nothing to reclassify/));
  });
});
