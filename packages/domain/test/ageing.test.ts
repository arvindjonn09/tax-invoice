import { describe, expect, it } from "vitest";
import {
  type AgeingDocument,
  ageingBucket,
  ageingReport,
  cashMovementReport,
  daysBetween,
  owedAsAt,
} from "../src/index";

// Ageing as at a day (#56): later settlements, credits and voids never
// rewrite an earlier ageing; buckets are by days past the due date.
const doc = (over: Partial<AgeingDocument> = {}): AgeingDocument => ({
  id: "inv-1",
  partyId: "c-1",
  issuedOn: "2026-07-01",
  dueOn: "2026-07-15",
  inclusive: 110000n,
  voidedOn: null,
  settlements: [],
  ...over,
});

describe("ageing", () => {
  it("buckets by days past due", () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map(ageingBucket)).toEqual([
      "current",
      "current",
      "days1To30",
      "days1To30",
      "days31To60",
      "days31To60",
      "days61To90",
      "days61To90",
      "days91Plus",
      "days91Plus",
    ]);
    expect(daysBetween("2026-02-27", "2026-03-01")).toBe(2);
    expect(daysBetween("2026-10-03", "2026-10-05")).toBe(2); // across DST
  });

  it("applies only settlements on or before the day, and not voided by then", () => {
    const d = doc({
      settlements: [
        { on: "2026-07-10", amount: 50000n, voidedOn: "2026-08-01" },
        { on: "2026-07-20", amount: 30000n, voidedOn: null },
        { on: "2026-07-25", amount: -10000n, voidedOn: null }, // refund
      ],
    });
    expect(owedAsAt(d, "2026-06-30")).toBe(0n);
    expect(owedAsAt(d, "2026-07-09")).toBe(110000n);
    expect(owedAsAt(d, "2026-07-10")).toBe(60000n);
    expect(owedAsAt(d, "2026-07-20")).toBe(30000n);
    expect(owedAsAt(d, "2026-07-25")).toBe(40000n);
    expect(owedAsAt(d, "2026-08-01")).toBe(90000n);
    expect(owedAsAt(doc({ voidedOn: "2026-07-31" }), "2026-07-30")).toBe(
      110000n,
    );
    expect(owedAsAt(doc({ voidedOn: "2026-07-31" }), "2026-07-31")).toBe(0n);
    expect(
      owedAsAt(
        doc({
          settlements: [{ on: "2026-07-02", amount: 120000n, voidedOn: null }],
        }),
        "2026-07-31",
      ),
    ).toBe(0n);
  });

  it("totals every row by bucket and party, oldest due first", () => {
    const report = ageingReport(
      [
        doc({ id: "b", dueOn: null, issuedOn: "2026-05-01" }),
        doc({ id: "a", partyId: "c-2", inclusive: 1n }),
        doc({
          id: "paid",
          settlements: [{ on: "2026-07-01", amount: 110000n, voidedOn: null }],
        }),
      ],
      "2026-08-15",
    );
    expect(report.rows.map((r) => [r.id, r.daysOverdue, r.bucket])).toEqual([
      ["b", 106, "days91Plus"],
      ["a", 31, "days31To60"],
    ]);
    expect(report.totals).toEqual({
      current: 0n,
      days1To30: 0n,
      days31To60: 1n,
      days61To90: 0n,
      days91Plus: 110000n,
      total: 110001n,
    });
    expect(report.parties.map((p) => [p.partyId, p.total])).toEqual([
      ["c-1", 110000n],
      ["c-2", 1n],
    ]);
    expect(() => ageingReport([], "31/08/2026")).toThrow(RangeError);
    // Ties: same due date sorts by issue date, then id; equal parties keep order.
    const ties = ageingReport(
      [
        doc({ id: "z", partyId: "p-1", inclusive: 5n }),
        doc({ id: "y", partyId: "p-2", inclusive: 5n }),
        doc({ id: "x", partyId: "p-3", inclusive: 9n, issuedOn: "2026-07-02" }),
        doc({ id: "w", partyId: "p-4", inclusive: 1n }),
      ],
      "2026-07-15",
    );
    expect(ties.rows.map((r) => r.id)).toEqual(["w", "y", "z", "x"]);
    expect(ties.parties.map((p) => p.partyId)).toEqual([
      "p-3",
      "p-2",
      "p-1",
      "p-4",
    ]);
  });
});

describe("cash movement", () => {
  it("is money in less money out by month, never profit", () => {
    const report = cashMovementReport(
      [
        { id: "1", date: "2026-07-02", direction: "in", amount: 110000n },
        { id: "2", date: "2026-07-31", direction: "out", amount: 33000n },
        { id: "3", date: "2026-08-01", direction: "in", amount: -10000n },
        { id: "4", date: "2026-10-01", direction: "in", amount: 5n },
      ],
      { from: "2026-07-01", to: "2026-09-30" },
    );
    expect(report).toEqual({
      label: "Cash movement — money in less money out, not profit",
      moneyIn: 100000n,
      moneyOut: 33000n,
      net: 67000n,
      months: [
        { month: "2026-07", moneyIn: 110000n, moneyOut: 33000n, net: 77000n },
        { month: "2026-08", moneyIn: -10000n, moneyOut: 0n, net: -10000n },
      ],
    });
    expect(() =>
      cashMovementReport([], { from: "2026-09-30", to: "2026-07-01" }),
    ).toThrow(RangeError);
  });
});
