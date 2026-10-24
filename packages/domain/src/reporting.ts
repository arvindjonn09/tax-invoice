import { isIsoDate } from "./registration";
import { jobProfit } from "./profit";
import { sum } from "./money";

/** Immutable, already attributed source facts. A settlement is never a cost. */
export type ReportEvent = {
  id: string;
  sourceId: string;
  date: string;
  jobId: string | null;
  customerId: string | null;
  channel:
    | "invoiced"
    | "incurred"
    | "received"
    | "paid"
    | "gst_sales"
    | "gst_purchases";
  amount: bigint;
  /** G1 eligible sales incl GST; only relevant to gst_sales. */
  salesInclusive?: bigint;
};
export type ReportFilter = {
  from: string;
  to: string;
  jobId?: string;
  customerId?: string;
};

export function selectReportEvents(
  events: readonly ReportEvent[],
  filter: ReportFilter,
): ReportEvent[] {
  if (
    !isIsoDate(filter.from) ||
    !isIsoDate(filter.to) ||
    filter.from > filter.to
  )
    throw new RangeError("Choose a valid inclusive date range");
  return events.filter(
    (e) =>
      e.date >= filter.from &&
      e.date <= filter.to &&
      (filter.jobId === undefined || e.jobId === filter.jobId) &&
      (filter.customerId === undefined || e.customerId === filter.customerId),
  );
}

/** Invoiced gross profit, with cash displayed separately, never as profit. */
export function profitabilityReport(
  events: readonly ReportEvent[],
  filter: ReportFilter,
) {
  const selected = selectReportEvents(events, filter).filter((e) =>
    ["invoiced", "incurred", "received", "paid"].includes(e.channel),
  );
  const totals = (rows: readonly ReportEvent[]) => ({
    ...jobProfit({
      revenueExclusive: rows
        .filter((e) => e.channel === "invoiced")
        .map((e) => e.amount),
      jobCosts: rows
        .filter((e) => e.channel === "incurred")
        .map((e) => e.amount),
    }),
    receivedInclusive: sum(
      rows.filter((e) => e.channel === "received").map((e) => e.amount),
    ),
    paidInclusive: sum(
      rows.filter((e) => e.channel === "paid").map((e) => e.amount),
    ),
  });
  const ids = [
    ...new Set(selected.flatMap((e) => (e.jobId === null ? [] : [e.jobId]))),
  ].sort();
  const customers = [
    ...new Set(
      selected.flatMap((e) => (e.customerId === null ? [] : [e.customerId])),
    ),
  ].sort();
  return {
    basis: "invoiced" as const,
    totals: totals(selected),
    jobs: ids.map((jobId) => ({
      jobId,
      ...totals(selected.filter((e) => e.jobId === jobId)),
    })),
    customers: customers.map((customerId) => ({
      customerId,
      ...totals(selected.filter((e) => e.customerId === customerId)),
    })),
    unallocated: totals(selected.filter((e) => e.jobId === null)),
    events: selected,
  };
}

/** Both bases consume dated source events; adjustments remain separate events. */
export function draftGstReport(
  events: readonly ReportEvent[],
  filter: ReportFilter,
) {
  const selected = selectReportEvents(events, filter).filter(
    (e) => e.channel === "gst_sales" || e.channel === "gst_purchases",
  );
  const sales = selected.filter((e) => e.channel === "gst_sales");
  const oneA = sum(sales.map((e) => e.amount));
  const oneB = sum(
    selected.filter((e) => e.channel === "gst_purchases").map((e) => e.amount),
  );
  return {
    label: "Draft BAS/GST summary — not lodged" as const,
    g1: sum(sales.map((e) => e.salesInclusive ?? 0n)),
    oneA,
    oneB,
    netGst: oneA - oneB,
    events: selected,
  };
}
