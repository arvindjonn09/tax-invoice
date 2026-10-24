import { createHash } from "node:crypto";
import { notFound } from "@jobflow/authz";
import { draftGstReport, gstStatusOn } from "@jobflow/domain";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { z } from "zod";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { sydneyToday, toDay } from "../company/gst";
import { requiredText, uuidOrNull } from "../http/fields";
import { Refusal, inTransaction } from "../jobs/handlers";
import { financialEvents } from "./events";
const Range = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    note: requiredText(1000, "Explain the finalisation"),
  })
  .refine((q) => q.from <= q.to, {
    path: ["to"],
    message: "End date must follow start date",
  });
const cents = z
  .string()
  .regex(/^-?\d{1,13}$/, "Use whole signed cents")
  .transform(BigInt)
  .refine(
    (v) => v >= -1000000000000n && v <= 1000000000000n,
    "Adjustment too large",
  );
const Adjustment = z
  .object({
    effectiveOn: z.iso.date(),
    g1: cents.default(0n),
    oneA: cents.default(0n),
    oneB: cents.default(0n),
    reason: requiredText(1000, "Explain the correction"),
  })
  .refine((a) => a.g1 !== 0n || a.oneA !== 0n || a.oneB !== 0n, {
    message: "Enter a nonzero correction",
  });
const refuse = (status: 400 | 409, error: string) =>
  new Refusal(privateJson({ error }, { status }));
const reportJson = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as Prisma.InputJsonValue;
/** Exclusive only for finalise/adjust; source writers hold shared gates. */
async function gate(tx: Prisma.TransactionClient, companyId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('jobflow-report:' || ${companyId}::text,0))::text`;
}
type Context = { params: Promise<{ id: string }> };
export function periodHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor }) =>
    privateJson({
      periods: await db().gstPeriod.findMany({
        where: { companyId: actor.companyId },
        include: { revisions: { orderBy: { revision: "asc" } } },
        orderBy: { startsOn: "desc" },
      }),
    });
  const close: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = Range.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const { from, to, note } = parsed.data;
    if (to >= sydneyToday())
      return privateJson(
        { error: "Only finished reporting periods can be finalised" },
        { status: 400 },
      );
    return inTransaction(async () => {
      const result = await withAudit(db(), async (tx, audit) => {
        await gate(tx, actor.companyId);
        const config = await tx.company.findUniqueOrThrow({
          where: { id: actor.companyId },
          select: { basPeriod: true },
        });
        const start = new Date(`${from}T00:00:00Z`),
          month = start.getUTCMonth();
        const end = new Date(
          Date.UTC(
            start.getUTCFullYear(),
            month + (config.basPeriod === "monthly" ? 1 : 3),
            0,
          ),
        );
        if (
          start.getUTCDate() !== 1 ||
          (config.basPeriod === "quarterly" && month % 3 !== 0) ||
          toDay(end) !== to
        )
          throw refuse(
            400,
            "Choose a complete configured monthly or quarterly period",
          );
        if (
          await tx.gstPeriod.findFirst({
            where: {
              companyId: actor.companyId,
              startsOn: { lte: new Date(`${to}T00:00:00Z`) },
              endsOn: { gte: start },
            },
          })
        )
          throw refuse(409, "That date range overlaps a finalised period");
        const source = await financialEvents(tx, actor.companyId);
        if (source.warnings.length)
          throw new Refusal(
            privateJson(
              {
                error:
                  "Resolve data-integrity warnings before finalising this GST period. No snapshot was created.",
                warnings: source.warnings,
              },
              { status: 409 },
            ),
          );
        const snapshot = reportJson(
          draftGstReport(source.events, { from, to }),
        );
        const period = await tx.gstPeriod.create({
          data: {
            companyId: actor.companyId,
            startsOn: start,
            endsOn: new Date(`${to}T00:00:00Z`),
            createdBy: actor.userId,
          },
        });
        const revision = await tx.gstReportRevision.create({
          data: {
            companyId: actor.companyId,
            periodId: period.id,
            revision: 1,
            report: snapshot,
            note,
            createdBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "gst_period.finalised",
          target: { type: "gst_period", id: period.id },
          after: { from, to, revision: 1 },
        });
        return { ...period, revisions: [revision] };
      });
      return privateJson(result, { status: 201 });
    });
  };
  const adjust =
    (amend: boolean): PolicyHandler<Context | undefined> =>
    async ({ actor, request, context }) => {
      const parsed = Adjustment.safeParse(await jsonOrNull(request));
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const key = request.headers.get("idempotency-key") ?? "";
      if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key))
        return privateJson(
          { error: "Send an Idempotency-Key for this correction" },
          { status: 400 },
        );

      if (data.effectiveOn > sydneyToday())
        return privateJson(
          { error: "Corrections cannot be future dated" },
          { status: 400 },
        );
      return inTransaction(async () => {
        const result = await withAudit(db(), async (tx, audit) => {
          await gate(tx, actor.companyId);
          const date = new Date(`${data.effectiveOn}T00:00:00Z`);
          const id =
            amend && context ? uuidOrNull((await context.params).id) : null;
          const period = id
            ? await tx.gstPeriod.findFirst({
                where: { id, companyId: actor.companyId },
              })
            : null;
          if (amend && !period) throw notFound();
          if (period && (date < period.startsOn || date > period.endsOn))
            throw refuse(
              400,
              "An amendment must be dated inside its finalised period",
            );
          const hash = createHash("sha256")
            .update(
              JSON.stringify({
                periodId: period?.id ?? null,
                effectiveOn: data.effectiveOn,
                g1: data.g1.toString(),
                oneA: data.oneA.toString(),
                oneB: data.oneB.toString(),
                reason: data.reason,
              }),
            )
            .digest("hex");
          const existing = await tx.gstManualAdjustment.findUnique({
            where: {
              companyId_idempotencyKey: {
                companyId: actor.companyId,
                idempotencyKey: key,
              },
            },
          });
          if (existing) {
            if (existing.requestHash !== hash)
              throw refuse(
                409,
                "That correction key was already used for different data",
              );
            const revision =
              existing.periodId && existing.reportRevision
                ? await tx.gstReportRevision.findUnique({
                    where: {
                      companyId_periodId_revision: {
                        companyId: actor.companyId,
                        periodId: existing.periodId,
                        revision: existing.reportRevision,
                      },
                    },
                  })
                : null;
            throw new Refusal(
              privateJson({
                adjustment: {
                  ...existing,
                  g1: existing.g1.toString(),
                  oneA: existing.oneA.toString(),
                  oneB: existing.oneB.toString(),
                },
                revision,
                replayed: true,
              }),
            );
          }
          if (
            !amend &&
            (await tx.gstPeriod.findFirst({
              where: {
                companyId: actor.companyId,
                startsOn: { lte: date },
                endsOn: { gte: date },
              },
            }))
          )
            throw refuse(
              409,
              "Use an explicit amended report for a finalised period",
            );
          const previous = period
            ? await tx.gstReportRevision.findFirstOrThrow({
                where: { companyId: actor.companyId, periodId: period.id },
                orderBy: { revision: "desc" },
              })
            : null;
          const source = await financialEvents(tx, actor.companyId);
          if (period && source.warnings.length)
            throw new Refusal(
              privateJson(
                {
                  error:
                    "Resolve data-integrity warnings before rebuilding the amended GST snapshot.",
                  warnings: source.warnings,
                },
                { status: 409 },
              ),
            );
          if (!gstStatusOn(source.periods, data.effectiveOn).registered)
            throw refuse(
              400,
              "Choose a date when the company was registered for GST",
            );
          const adjustment = await tx.gstManualAdjustment.create({
            data: {
              companyId: actor.companyId,
              periodId: period?.id ?? null,
              idempotencyKey: key,
              requestHash: hash,
              reportRevision: previous ? previous.revision + 1 : null,
              effectiveOn: date,
              g1: data.g1,
              oneA: data.oneA,
              oneB: data.oneB,
              reason: data.reason,
              createdBy: actor.userId,
            },
          });
          let revision = null;
          if (period) {
            const updated = await financialEvents(tx, actor.companyId);
            revision = await tx.gstReportRevision.create({
              data: {
                companyId: actor.companyId,
                periodId: period.id,
                revision: previous!.revision + 1,
                report: reportJson(
                  draftGstReport(updated.events, {
                    from: toDay(period.startsOn),
                    to: toDay(period.endsOn),
                  }),
                ),
                note: data.reason,
                createdBy: actor.userId,
              },
            });
          }
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: amend ? "gst_period.amended" : "gst.adjusted",
            target: { type: "gst_adjustment", id: adjustment.id },
            after: {
              effectiveOn: data.effectiveOn,
              g1: data.g1,
              oneA: data.oneA,
              oneB: data.oneB,
              reason: data.reason,
              periodId: period?.id ?? null,
            },
          });
          return {
            adjustment: {
              ...adjustment,
              g1: adjustment.g1.toString(),
              oneA: adjustment.oneA.toString(),
              oneB: adjustment.oneB.toString(),
            },
            revision,
          };
        });
        return privateJson(result, { status: 201 });
      });
    };
  const openAdjustment: PolicyHandler<unknown> = (input) =>
    adjust(false)({ ...input, context: undefined });
  const amendPeriod: PolicyHandler<Context> = (input) => adjust(true)(input);
  return { list, close, adjust: openAdjustment, amend: amendPeriod };
}
