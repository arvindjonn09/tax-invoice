import { describe, expect, it } from "vitest";
import {
  draftGstReport,
  profitabilityReport,
  selectReportEvents,
  type ReportEvent,
} from "../src/index";
const range = { from: "2026-07-01", to: "2026-09-30" };
const event = (
  id: string,
  channel: ReportEvent["channel"],
  amount: bigint,
  extra: Partial<ReportEvent> = {},
): ReportEvent => ({
  id,
  sourceId: id,
  channel,
  amount,
  date: "2026-07-15",
  jobId: "job1",
  customerId: "customer1",
  ...extra,
});
describe("GST and profitability reporting together (#54/#55)", () => {
  for (const registered of [true, false])
    it(`combined fixture, registered=${registered}`, () => {
      const events = [
        event("invoice", "invoiced", 250000n),
        ...[90000n, 30000n, 15000n, 10000n].map((cost, i) =>
          event(`cost${i}`, "incurred", cost),
        ),
      ];
      if (registered)
        events.push(
          event("sale", "gst_sales", 25000n, { salesInclusive: 275000n }),
          event("credit", "gst_purchases", 10500n),
        );
      expect(profitabilityReport(events, range).totals).toMatchObject({
        revenue: 250000n,
        cost: 145000n,
        profit: 105000n,
        marginBasisPoints: 4200n,
      });
      expect(draftGstReport(events, range)).toMatchObject({
        oneA: registered ? 25000n : 0n,
        oneB: registered ? 10500n : 0n,
        netGst: registered ? 14500n : 0n,
      });
      events.push(
        event("receipt", "received", 100000n),
        event("payment", "paid", 40000n),
      );
      const report = profitabilityReport(events, range);
      expect(report.totals).toMatchObject({
        profit: 105000n,
        receivedInclusive: 100000n,
        paidInclusive: 40000n,
      });
      expect(report.jobs[0]).toMatchObject({ jobId: "job1", profit: 105000n });
      expect(report.customers[0]).toMatchObject({
        customerId: "customer1",
        profit: 105000n,
      });
    });
  it("includes non-creditable GST in cost; preserves cancelled job costs and reversals", () => {
    const events = [
      event("sale", "invoiced", 250000n),
      event("cost", "incurred", 146500n),
      event("reverse", "incurred", -100n),
    ];
    expect(profitabilityReport(events, range).totals.profit).toBe(103600n);
    expect(
      draftGstReport(
        [event("a", "gst_sales", 25000n), event("b", "gst_purchases", 9000n)],
        range,
      ).netGst,
    ).toBe(16000n);
  });
  it("filters inclusive dates, customer and job without dropping unallocated costs", () => {
    const events = [
      event("a", "incurred", 100n, { jobId: null, customerId: null }),
      event("b", "invoiced", 200n, { date: range.from }),
      event("c", "invoiced", 300n, { date: range.to }),
      event("d", "invoiced", 999n, { date: "2026-10-01" }),
    ];
    expect(profitabilityReport(events, range).unallocated.cost).toBe(100n);
    expect(
      selectReportEvents(events, {
        ...range,
        jobId: "job1",
        customerId: "customer1",
      }),
    ).toHaveLength(2);
    expect(
      selectReportEvents(events, { ...range, jobId: "other" }),
    ).toHaveLength(0);
    expect(
      selectReportEvents(events, { ...range, customerId: "other" }),
    ).toHaveLength(0);
    expect(draftGstReport(events, range).g1).toBe(0n);
    expect(profitabilityReport([], range).totals.marginBasisPoints).toBeNull();
  });
  it("keeps dated GST adjustments in their own period", () => {
    const events = [
      event("original", "gst_sales", 1n, {
        salesInclusive: 11n,
        date: "2026-06-30",
      }),
      event("void", "gst_sales", -1n, { salesInclusive: -1n }),
      event("adjust", "gst_sales", -1n),
    ];
    expect(draftGstReport(events, range)).toMatchObject({
      g1: -1n,
      oneA: -2n,
      oneB: 0n,
      netGst: -2n,
    });
    expect(
      draftGstReport(events, { from: "2026-06-01", to: "2026-06-30" }).oneA,
    ).toBe(1n);
  });
  it.each([
    { from: "bad", to: range.to },
    { from: range.from, to: "2026-02-30" },
    { from: range.to, to: range.from },
  ])("refuses invalid ranges %o", (filter) => {
    expect(() => selectReportEvents([], filter)).toThrow(RangeError);
  });
});
