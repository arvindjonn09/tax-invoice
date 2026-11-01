import { can, notFound, requirePermission, type Actor } from "@jobflow/authz";
import {
  ageingReport,
  draftGstReport,
  profitabilityReport,
} from "@jobflow/domain";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { z } from "zod";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import { sydneyToday } from "../company/gst";
import { businessDay, financialEvents } from "../reports/events";
import {
  receivablesSource,
  payablesSource,
  type AgeingSource,
} from "../reports/ledger";

const Query = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    customerId: z.uuid().optional(),
    jobId: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, {
    message: "End date must be on or after start date",
    path: ["to"],
  });

async function balances(
  tx: Prisma.TransactionClient,
  companyId: string,
  query: z.infer<typeof Query>,
  side: "receivables" | "payables",
  asAt: string,
) {
  const source: AgeingSource = await (side === "receivables"
    ? receivablesSource(tx, companyId, asAt)
    : payablesSource(tx, companyId, asAt));
  let documents = source.documents;
  if (query.jobId || query.customerId) {
    const ids = documents.map((d) => d.id);
    const matches =
      side === "receivables"
        ? await tx.invoice.findMany({
            where: {
              companyId,
              id: { in: ids },
              ...(query.jobId ? { jobId: query.jobId } : {}),
              ...(query.customerId ? { customerId: query.customerId } : {}),
            },
            select: { id: true },
          })
        : await tx.supplierBill.findMany({
            where: {
              companyId,
              id: { in: ids },
              ...(query.jobId ? { jobId: query.jobId } : {}),
              ...(query.customerId
                ? { job: { customerId: query.customerId } }
                : {}),
            },
            select: { id: true },
          });
    const included = new Set(matches.map((m) => m.id));
    documents = documents.filter((d) => included.has(d.id));
  }
  const report = ageingReport(documents, asAt);
  return {
    total: report.totals.total,
    overdue: report.totals.total - report.totals.current,
    // Only the display list is capped; totals cover every outstanding record.
    overdueCount: report.rows.filter((r) => r.daysOverdue > 0).length,
    documents: report.rows
      .filter((r) => r.daysOverdue > 0)
      .slice(0, 10)
      .map((r) => ({ ...r, ...source.labels.get(r.id)! })),
  };
}

export async function loadDashboard(
  tx: Prisma.TransactionClient,
  actor: Actor,
  query: z.infer<typeof Query>,
) {
  requirePermission(actor, "job.profit.read");
  if (
    query.jobId &&
    !(await tx.job.findFirst({
      where: { id: query.jobId, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    throw notFound();
  if (
    query.customerId &&
    !(await tx.customer.findFirst({
      where: { id: query.customerId, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    throw notFound();
  const source = await financialEvents(tx, actor.companyId, {
    since: query.from,
  });
  const filter = {
    from: query.from,
    to: query.to,
    ...(query.jobId ? { jobId: query.jobId } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
  };
  const profit = profitabilityReport(source.events, filter);
  const warnings = source.warnings.filter(
    (w) =>
      (!query.jobId || w.jobId === query.jobId) &&
      (!query.customerId || w.customerId === query.customerId),
  );
  const asAt = query.to < sydneyToday() ? query.to : sydneyToday();
  const ledger = can(actor.role, "ledger_report.read")
    ? {
        asAt,
        receivables: await balances(
          tx,
          actor.companyId,
          query,
          "receivables",
          asAt,
        ),
        payables: await balances(tx, actor.companyId, query, "payables", asAt),
      }
    : null;
  let gst: {
    g1: bigint;
    oneA: bigint;
    oneB: bigint;
    netGst: bigint;
    revision: number | null;
    incomplete: boolean;
  } | null = null;
  if (can(actor.role, "gst_report.read")) {
    const period =
      !query.jobId && !query.customerId
        ? await tx.gstPeriod.findFirst({
            where: {
              companyId: actor.companyId,
              startsOn: new Date(query.from),
              endsOn: new Date(query.to),
            },
            include: { revisions: { orderBy: { revision: "desc" }, take: 1 } },
          })
        : null;
    const revision = period?.revisions[0];
    if (revision) {
      const stored = revision.report as {
        g1: string;
        oneA: string;
        oneB: string;
        netGst: string;
      };
      gst = {
        g1: BigInt(stored.g1),
        oneA: BigInt(stored.oneA),
        oneB: BigInt(stored.oneB),
        netGst: BigInt(stored.netGst),
        revision: revision.revision,
        incomplete: false,
      };
    } else {
      const report = draftGstReport(source.events, filter);
      gst = {
        g1: report.g1,
        oneA: report.oneA,
        oneB: report.oneB,
        netGst: report.netGst,
        revision: null,
        incomplete: warnings.some((w) => w.omittedGst),
      };
    }
  }
  const [customers, recentJobs] = await Promise.all([
    tx.customer.findMany({
      where: { companyId: actor.companyId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    tx.job.findMany({
      where: {
        companyId: actor.companyId,
        ...(query.jobId ? { id: query.jobId } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
      },
      select: {
        id: true,
        reference: true,
        title: true,
        status: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: 8,
    }),
  ]);
  return {
    range: query,
    generatedAt: new Date().toISOString(),
    totals: profit.totals,
    gst,
    ledger,
    warnings,
    jobs: source.jobs.map((j) => ({
      id: j.id,
      reference: j.reference,
      title: j.title,
      customerId: j.customerId,
    })),
    customers,
    recentJobs: recentJobs.map((j) => ({
      ...j,
      updatedOn: businessDay(j.updatedAt),
      updatedAt: j.updatedAt.toISOString(),
    })),
  };
}

type Json<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
export type DashboardData = Json<Awaited<ReturnType<typeof loadDashboard>>>;
export function dashboardHandler(
  db: () => PrismaClient,
): PolicyHandler<unknown> {
  return async ({ actor, request }) => {
    const parsed = Query.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) return invalid(parsed.error);
    const data = await db().$transaction(
      (tx) => loadDashboard(tx, actor, parsed.data),
      { isolationLevel: "RepeatableRead" },
    );
    return privateJson(
      JSON.parse(
        JSON.stringify(data, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ),
    );
  };
}
