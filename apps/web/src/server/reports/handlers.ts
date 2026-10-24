import { notFound } from "@jobflow/authz";
import {
  draftGstReport,
  profitabilityReport,
  jobProfit,
  outstandingCommitment,
  type ReportFilter,
} from "@jobflow/domain";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { z } from "zod";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import { businessDay, financialEvents } from "./events";
const Query = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    jobId: z.uuid().optional(),
    customerId: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, {
    message: "End date must be on or after start date",
    path: ["to"],
  });
/** Money exits as exact cent strings, including drill-down facts. */
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as unknown;
export function reportHandlers(db: () => PrismaClient) {
  const run =
    (gst: boolean): PolicyHandler<unknown> =>
    async ({ actor, request }) => {
      const parsed = Query.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!parsed.success) return invalid(parsed.error);
      const query: ReportFilter = {
        from: parsed.data.from,
        to: parsed.data.to,
        ...(parsed.data.jobId ? { jobId: parsed.data.jobId } : {}),
        ...(parsed.data.customerId
          ? { customerId: parsed.data.customerId }
          : {}),
      };
      return db().$transaction(
        async (tx) => {
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
          if (gst && !query.jobId && !query.customerId) {
            const finalized = await tx.gstPeriod.findFirst({
              where: {
                companyId: actor.companyId,
                startsOn: new Date(`${query.from}T00:00:00Z`),
                endsOn: new Date(`${query.to}T00:00:00Z`),
              },
              include: {
                revisions: { orderBy: { revision: "desc" }, take: 1 },
              },
            });
            if (finalized?.revisions[0])
              return privateJson({
                range: query,
                ...(finalized.revisions[0].report as Record<string, unknown>),
                finalization: {
                  periodId: finalized.id,
                  revision: finalized.revisions[0].revision,
                  lockedAt: finalized.lockedAt,
                },
              });
          }
          const source = await financialEvents(tx, actor.companyId);
          const positions = source.jobs
            .filter(
              (job) =>
                (!query.jobId || query.jobId === job.id) &&
                (!query.customerId || query.customerId === job.customerId),
            )
            .map((job) => {
              const estimates = source.quotes.filter(
                (quote) =>
                  quote.jobId === job.id &&
                  quote.decidedAt &&
                  businessDay(quote.decidedAt) <= query.to,
              );
              return {
                jobId: job.id,
                customerId: job.customerId,
                reference: job.reference,
                title: job.title,
                status: job.status,
                currentAgreedRevenueExclusive: job.agreedPriceExclusiveCents,
                estimated: estimates.length
                  ? {
                      asOf: query.to,
                      quoteIds: estimates.map((quote) => quote.id),
                      ...jobProfit({
                        revenueExclusive: estimates.map(
                          (quote) => quote.exclusiveCents,
                        ),
                        jobCosts: estimates.map(
                          (quote) => quote.estimatedCostCents,
                        ),
                      }),
                    }
                  : null,
                committedCost: source.acceptances
                  .filter(
                    (a) =>
                      a.jobId === job.id &&
                      businessDay(a.acceptedAt) <= query.to,
                  )
                  .reduce(
                    (total, a) =>
                      total +
                      outstandingCommitment({
                        committed: a.committedCostCents,
                        committedExclusive: a.exclusiveCents,
                        billedExclusive: source.bills
                          .filter(
                            (b) =>
                              b.offerId === a.offerId &&
                              b.issuedOn.toISOString().slice(0, 10) <=
                                query.to &&
                              (!b.voidedAt ||
                                new Intl.DateTimeFormat("en-CA", {
                                  timeZone: "Australia/Sydney",
                                }).format(b.voidedAt) > query.to),
                          )
                          .map((b) => b.exclusiveCents),
                      }),
                    0n,
                  ),
              };
            });
          return privateJson(
            json({
              range: query,
              ...(gst
                ? draftGstReport(source.events, query)
                : {
                    ...profitabilityReport(source.events, query),
                    positions,
                    committedCost: positions.reduce(
                      (total, p) => total + p.committedCost,
                      0n,
                    ),
                  }),
            }),
          );
        },
        { isolationLevel: "RepeatableRead" },
      );
    };
  return { profitability: run(false), gst: run(true) };
}
