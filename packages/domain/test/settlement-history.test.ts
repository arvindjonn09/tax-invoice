import { describe, expect, it } from "vitest";
import {
  compareSettlementDates,
  settlementHistoryProblem,
  type DatedSettlement,
} from "../src/index";
const event = (
  id: string,
  date: string,
  amount: bigint,
  recordedAt = "2026-10-01T00:00:00.000Z",
): DatedSettlement => ({ id, date, amount, recordedAt });
describe("date-ordered settlement bounds", () => {
  it("rejects a backdated replacement despite an acceptable current balance", () => {
    const rows = [
      event("aug", "2026-08-01", 100n),
      event("refund", "2026-09-01", -100n),
    ];
    expect(settlementHistoryProblem(100n, rows)).toBeNull();
    expect(
      settlementHistoryProblem(100n, [
        ...rows,
        event("july", "2026-07-01", 100n),
      ]),
    ).toEqual({ date: "2026-08-01", balance: 200n });
    expect(rows.map((row) => row.id)).toEqual(["aug", "refund"]);
  });
  it("rejects a refund before the money arrived and accepts bounded reversals", () => {
    expect(
      settlementHistoryProblem(100n, [
        event("refund", "2026-07-01", -1n),
        event("paid", "2026-08-01", 100n),
      ]),
    ).toEqual({ date: "2026-07-01", balance: -1n });
    expect(
      settlementHistoryProblem(100n, [
        event("paid", "2026-08-01", 100n),
        event("void", "2026-10-01", -100n),
      ]),
    ).toBeNull();
    expect(settlementHistoryProblem(0n, [])).toBeNull();
  });
  it("uses the persisted timestamp and stable id for same-day ties", () => {
    const a = event("a", "2026-08-01", 100n, "2026-10-01T00:00:00.001Z");
    const b = event("b", "2026-08-01", -100n, "2026-10-01T00:00:00.002Z");
    expect(compareSettlementDates(a, b)).toBeLessThan(0);
    expect(compareSettlementDates(a, { ...a, id: "b" })).toBeLessThan(0);
    expect(compareSettlementDates(a, a)).toBe(0);
    expect(settlementHistoryProblem(100n, [b, a])).toBeNull();
  });
});
