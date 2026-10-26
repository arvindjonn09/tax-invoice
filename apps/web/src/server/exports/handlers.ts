import {
  draftGstReport,
  profitabilityReport,
  type ReportEvent,
} from "@jobflow/domain";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { z } from "zod";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import { financialEvents } from "../reports/events";
import { sourceLabels } from "../reports/sources";
import {
  AgeingQuery,
  CashQuery,
  ageing,
  cashMovement,
} from "../reports/ledger";
import { type CsvColumn, csvStream } from "./csv";

// Accountant exports (#56), `export.run` only (owner/accountant). Every
// export is read inside ONE RepeatableRead snapshot with an audit event,
// then streamed. Money columns are signed integer cents, GST-inclusive or
// exclusive as each column name says; docs/exports.md is the schema.

/** Inclusive date range (shared with the cash report). */
const Range = CashQuery;
export const EXPORTS = [
  "gst-summary",
  "gst-lines",
  "profitability",
  "ageing",
  "cash",
] as const;
export type ExportName = (typeof EXPORTS)[number];

/** Stored snapshot money is cent strings; back to bigint for the export. */
const big = (value: unknown) => BigInt(String(value ?? "0"));

/** The finalised revision for exactly this range, if any. */
async function finalised(
  tx: Prisma.TransactionClient,
  companyId: string,
  range: { from: string; to: string },
) {
  const period = await tx.gstPeriod.findFirst({
    where: {
      companyId,
      startsOn: new Date(`${range.from}T00:00:00Z`),
      endsOn: new Date(`${range.to}T00:00:00Z`),
    },
    include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
  });
  const revision = period?.revisions[0];
  return revision
    ? {
        revision: revision.revision,
        report: revision.report as {
          g1: string;
          oneA: string;
          oneB: string;
          netGst: string;
          events: (Omit<ReportEvent, "amount" | "salesInclusive"> & {
            amount: string;
            salesInclusive?: string;
          })[];
        },
      }
    : null;
}

type Built = { filename: string; columns: CsvColumn<never>[]; rows: unknown[] };
const built = <Row>(
  filename: string,
  columns: CsvColumn<Row>[],
  rows: Row[],
): Built => ({
  filename,
  columns: columns as unknown as CsvColumn<never>[],
  rows,
});

/** Read one export's rows; the caller holds the snapshot transaction. */
export async function buildExport(
  tx: Prisma.TransactionClient,
  companyId: string,
  name: ExportName,
  params: Record<string, string>,
): Promise<Built | z.ZodError> {
  if (name === "ageing") {
    const parsed = AgeingQuery.safeParse(params);
    if (!parsed.success) return parsed.error;
    const { side, asAt } = parsed.data;
    const report = await ageing(tx, companyId, side, asAt);
    type Row = (typeof report.rows)[number];
    return built<Row>(
      `jobflow-ageing-${side}-${asAt}.csv`,
      [
        { name: "as_at", type: "date", value: () => asAt },
        { name: "side", type: "text", value: () => side },
        { name: "document_id", type: "text", value: (r) => r.id },
        { name: "reference", type: "text", value: (r) => r.reference },
        { name: "party_type", type: "text", value: (r) => r.partyType },
        { name: "party_name", type: "text", value: (r) => r.partyName },
        { name: "issued_on", type: "date", value: (r) => r.issuedOn },
        { name: "due_on", type: "date", value: (r) => r.dueOn },
        { name: "days_overdue", type: "integer", value: (r) => r.daysOverdue },
        { name: "bucket", type: "text", value: (r) => r.bucket },
        {
          name: "document_inclusive_cents",
          type: "cents",
          value: (r) => r.inclusive,
        },
        { name: "owed_inclusive_cents", type: "cents", value: (r) => r.owed },
      ],
      report.rows,
    );
  }
  const parsed = Range.safeParse(params);
  if (!parsed.success) return parsed.error;
  const range = parsed.data;
  const suffix = `${range.from}-${range.to}`;
  if (name === "cash") {
    const report = await cashMovement(tx, companyId, range);
    type Row = (typeof report.months)[number];
    return built<Row>(
      `jobflow-cash-movement-${suffix}.csv`,
      [
        { name: "month", type: "text", value: (r) => r.month },
        {
          name: "money_in_inclusive_cents",
          type: "cents",
          value: (r) => r.moneyIn,
        },
        {
          name: "money_out_inclusive_cents",
          type: "cents",
          value: (r) => r.moneyOut,
        },
        { name: "net_cash_cents", type: "cents", value: (r) => r.net },
      ],
      report.months,
    );
  }
  if (name === "profitability") {
    const source = await financialEvents(tx, companyId, { since: range.from });
    const report = profitabilityReport(source.events, range);
    const jobs = new Map(source.jobs.map((job) => [job.id, job]));
    const rows = [
      ...report.jobs.map(({ jobId, ...j }) => ({
        row: "job",
        jobId: jobId as string | null,
        ...j,
      })),
      { row: "unallocated", jobId: null, ...report.unallocated },
      { row: "total", jobId: null, ...report.totals },
    ];
    type Row = (typeof rows)[number];
    return built<Row>(
      `jobflow-profitability-${suffix}.csv`,
      [
        { name: "from", type: "date", value: () => range.from },
        { name: "to", type: "date", value: () => range.to },
        { name: "row_type", type: "text", value: (r) => r.row },
        { name: "job_id", type: "text", value: (r) => r.jobId },
        {
          name: "job_reference",
          type: "text",
          value: (r) => (r.jobId ? (jobs.get(r.jobId)?.reference ?? "") : ""),
        },
        {
          name: "job_title",
          type: "text",
          value: (r) => (r.jobId ? (jobs.get(r.jobId)?.title ?? "") : ""),
        },
        {
          name: "revenue_exclusive_cents",
          type: "cents",
          value: (r) => r.revenue,
        },
        {
          name: "job_cost_exclusive_cents",
          type: "cents",
          value: (r) => r.cost,
        },
        { name: "gross_profit_cents", type: "cents", value: (r) => r.profit },
        {
          name: "margin_basis_points",
          type: "integer",
          value: (r) => r.marginBasisPoints,
        },
        {
          name: "received_inclusive_cents",
          type: "cents",
          value: (r) => r.receivedInclusive,
        },
        {
          name: "paid_inclusive_cents",
          type: "cents",
          value: (r) => r.paidInclusive,
        },
      ],
      rows,
    );
  }
  // GST: a finalised period exports its locked revision, exactly as shown.
  const locked = await finalised(tx, companyId, range);
  const gst = locked
    ? {
        status: "finalised",
        revision: locked.revision as number | null,
        g1: big(locked.report.g1),
        oneA: big(locked.report.oneA),
        oneB: big(locked.report.oneB),
        netGst: big(locked.report.netGst),
        events: locked.report.events.map((e) => ({
          ...e,
          amount: big(e.amount),
          salesInclusive:
            e.salesInclusive === undefined ? undefined : big(e.salesInclusive),
        })),
      }
    : {
        status: "draft",
        revision: null,
        ...draftGstReport(
          (await financialEvents(tx, companyId, { since: range.from })).events,
          range,
        ),
      };
  if (name === "gst-summary") {
    const label = "Draft BAS/GST summary — not lodged";
    return built(
      `jobflow-gst-summary-${suffix}.csv`,
      [
        { name: "from", type: "date", value: () => range.from },
        { name: "to", type: "date", value: () => range.to },
        { name: "status", type: "text", value: () => gst.status },
        { name: "revision", type: "integer", value: () => gst.revision },
        {
          name: "g1_total_sales_inclusive_cents",
          type: "cents",
          value: () => gst.g1,
        },
        {
          name: "label_1a_gst_on_sales_cents",
          type: "cents",
          value: () => gst.oneA,
        },
        {
          name: "label_1b_gst_on_purchases_cents",
          type: "cents",
          value: () => gst.oneB,
        },
        { name: "net_gst_cents", type: "cents", value: () => gst.netGst },
        { name: "label", type: "text", value: () => label },
      ],
      [null],
    );
  }
  const labels = await sourceLabels(
    tx,
    companyId,
    gst.events.map((e) => e.sourceId),
  );
  type Row = (typeof gst.events)[number];
  return built<Row>(
    `jobflow-gst-lines-${suffix}.csv`,
    [
      { name: "date", type: "date", value: (e) => e.date },
      { name: "event_id", type: "text", value: (e) => e.id },
      {
        name: "bas_label",
        type: "text",
        value: (e) => (e.channel === "gst_sales" ? "1A" : "1B"),
      },
      {
        name: "source_type",
        type: "text",
        value: (e) => labels.get(e.sourceId)?.type ?? "",
      },
      { name: "source_id", type: "text", value: (e) => e.sourceId },
      {
        name: "source_reference",
        type: "text",
        value: (e) => labels.get(e.sourceId)?.reference ?? "",
      },
      {
        name: "party_name",
        type: "text",
        value: (e) => labels.get(e.sourceId)?.party ?? "",
      },
      { name: "job_id", type: "text", value: (e) => e.jobId },
      { name: "gst_cents", type: "cents", value: (e) => e.amount },
      {
        name: "g1_sales_inclusive_cents",
        type: "cents",
        value: (e) => e.salesInclusive ?? null,
      },
      { name: "period_status", type: "text", value: () => gst.status },
    ],
    gst.events,
  );
}

export function exportHandlers(db: () => PrismaClient) {
  const run: PolicyHandler<{ params: Promise<{ name: string }> }> = async ({
    actor,
    request,
    context,
  }) => {
    const name = z.enum(EXPORTS).safeParse((await context.params).name);
    if (!name.success)
      return privateJson({ error: "Not found" }, { status: 404 });
    const params = Object.fromEntries(new URL(request.url).searchParams);
    // Validate before the audited snapshot: a refused request reads nothing.
    const checked = (name.data === "ageing" ? AgeingQuery : Range).safeParse(
      params,
    );
    if (!checked.success) return invalid(checked.error);
    const result = await withAudit(
      db(),
      async (tx, audit) => {
        const out = await buildExport(tx, actor.companyId, name.data, params);
        if (out instanceof z.ZodError) return out;
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "report.exported",
          target: { type: "report_export", id: name.data },
          after: { export: name.data, params, rows: out.rows.length },
        });
        return out;
      },
      { isolationLevel: "RepeatableRead" },
    );
    if (result instanceof z.ZodError) return invalid(result);
    return new Response(
      csvStream(result.columns, result.rows as Iterable<never>),
      {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${result.filename}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  };
  return { run };
}
