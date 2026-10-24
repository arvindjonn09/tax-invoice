import {
  type Actor,
  companyScope,
  notFound,
  requireSameCompany,
} from "@jobflow/authz";
import {
  type GstLine,
  type InvoiceLineInput,
  type QuoteStatus,
  TAX_CODES,
  type TaxCode,
  acceptProblem,
  documentTotals,
  formatJobReference,
  invoiceLines,
  quoteEstimate,
  quoteState,
  revenueAfterAcceptance,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
  Quote,
  QuoteItem,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { companyGstStatusOn, sydneyToday, toDay } from "../company/gst";
import { lockRow } from "../db/locks";
import { nextNumber } from "../db/numbering";
import { optionalText, requiredText, uuidOrNull } from "../http/fields";
import { parsePage } from "../http/guards";
import { Refusal, inTransaction } from "../jobs/handlers";

// #44. Quotes and variations: office reads (quote.read); owner and manager
// write (quote.write). Prices and tax freeze when a quote is sent; the
// customer's decision is recorded once. Accepting converts: a quote creates
// (or approves) its job with estimated revenue = quote ex GST; a variation
// adds its ex-GST amount. Estimated cost and profit are internal.

type Row = Quote & { items: QuoteItem[] };
type IdContext = { params: Promise<{ id: string }> };

const cents = z
  .union([z.string().regex(/^\d{1,13}$/, "Whole cents only"), z.number().int()])
  .transform((value, context) => {
    const amount = BigInt(value);
    if (amount < 0n || amount > 1_000_000_000_000n) {
      context.addIssue({ code: "custom", message: "Enter an amount from $0" });
      return z.NEVER;
    }
    return amount;
  });
const day = z.iso.date("Use a date like 2026-07-01");

const Line = z.object({
  description: requiredText(500, "Describe the work"),
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,4})?$/, "Up to 4 decimal places")
    .refine((value) => /[1-9]/.test(value), "Quantity must be more than 0"),
  unit: optionalText(20).optional(),
  unitPriceCents: cents,
  taxCode: z.enum(TAX_CODES as [TaxCode, ...TaxCode[]]),
  /** Internal estimate for the line (all units), ex GST; never sent out. */
  estimatedCostCents: cents.optional(),
});

const header = {
  locationId: z.uuid().nullable(),
  title: requiredText(200, "Give the quote a title"),
  scope: optionalText(4000),
  priceEntry: z.enum(["exclusive", "inclusive"]),
  validUntil: day.nullable(),
  notes: optionalText(2000),
  lines: z.array(Line).max(200),
};
const CreateQuote = z
  .object({
    customerId: z.uuid("Choose a customer"),
    kind: z.enum(["quote", "variation"]),
    jobId: z.uuid().nullable(),
    ...header,
  })
  .partial()
  .required({ customerId: true, title: true });
const UpdateQuote = z
  .object(header)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
const Send = z.object({ sentOn: day.optional() });
const Decide = z.object({ note: optionalText(500).optional() });

const STATUS = z
  .enum(["draft", "sent", "accepted", "declined", "superseded"])
  .optional()
  .catch(undefined);

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    { status },
  );
const refuse = (status: 400 | 409, error: string, field?: string) =>
  new Refusal(fail(status, error, field));

const money = (value: bigint) => value.toString();
const asDay = (value: Date | null) => (value ? toDay(value) : null);
const midnight = (value: string) => new Date(`${value}T00:00:00Z`);

/** "Q-0042" or "Q-0042 rev 2". */
export function quoteReference(number: number, revision: number) {
  const base = `Q-${number.toString().padStart(4, "0")}`;
  return revision > 1 ? `${base} rev ${revision}` : base;
}

function view(row: Row) {
  const items = [...row.items].sort((a, b) => a.position - b.position);
  const estimate = quoteEstimate(
    items.map(gstLine),
    items.map((item) => item.estimatedCostCents),
  );
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    state: quoteState(row.status, asDay(row.validUntil), sydneyToday()),
    number: row.number,
    revision: row.revision,
    reference: quoteReference(row.number, row.revision),
    revisesId: row.revisesId,
    customerId: row.customerId,
    locationId: row.locationId,
    jobId: row.jobId,
    title: row.title,
    scope: row.scope,
    priceEntry: row.priceEntry,
    validUntil: asDay(row.validUntil),
    notes: row.notes,
    gstRegistered: row.gstRegistered,
    exclusiveCents: money(row.exclusiveCents),
    gstCents: money(row.gstCents),
    inclusiveCents: money(row.inclusiveCents),
    // Internal: estimated revenue and profit are GST-exclusive.
    estimate: {
      revenueExclusiveCents: money(estimate.exclusive),
      costCents: money(estimate.estimatedCost),
      profitCents: money(estimate.estimatedProfit),
      marginBasisPoints:
        estimate.marginBasisPoints === null
          ? null
          : money(estimate.marginBasisPoints),
    },
    sentOn: asDay(row.sentOn),
    sentAt: row.sentAt,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    lines: items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPriceCents: money(item.unitPriceCents),
      taxCode: item.taxCode,
      gstRateBasisPoints: item.gstRateBasisPoints,
      exclusiveCents: money(item.exclusiveCents),
      gstCents: money(item.gstCents),
      inclusiveCents: money(item.inclusiveCents),
      estimatedCostCents: money(item.estimatedCostCents),
    })),
  };
}

const gstLine = (item: QuoteItem): GstLine => ({
  taxCode: item.taxCode,
  rateBasisPoints: BigInt(item.gstRateBasisPoints),
  exclusive: item.exclusiveCents,
  gst: item.gstCents,
  inclusive: item.inclusiveCents,
});

type LineInput = z.infer<typeof Line>;

const toDomain = (line: LineInput): InvoiceLineInput => ({
  description: line.description,
  quantity: line.quantity,
  unitPrice: line.unitPriceCents,
  taxCode: line.taxCode,
});

/** Draft pricing assumes registration; sending re-prices on the send date. */
function priced(
  lines: readonly LineInput[],
  priceEntry: "exclusive" | "inclusive",
  registered = true,
) {
  const amounts = invoiceLines(lines.map(toDomain), priceEntry, registered);
  return {
    amounts,
    totals: documentTotals(amounts),
    estimatedCost: lines.reduce(
      (total, line) => total + (line.estimatedCostCents ?? 0n),
      0n,
    ),
  };
}

function itemRows(
  companyId: string,
  quoteId: string,
  lines: readonly LineInput[],
  amounts: readonly GstLine[],
): Prisma.QuoteItemCreateManyInput[] {
  return lines.map((line, position) => {
    const amount = amounts[position]!;
    return {
      companyId,
      quoteId,
      position,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit ?? null,
      unitPriceCents: line.unitPriceCents,
      taxCode: line.taxCode,
      gstRateBasisPoints: Number(amount.rateBasisPoints),
      exclusiveCents: amount.exclusive,
      gstCents: amount.gst,
      inclusiveCents: amount.inclusive,
      estimatedCostCents: line.estimatedCostCents ?? 0n,
    };
  });
}

const linesOf = (row: Row): LineInput[] =>
  [...row.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPriceCents: item.unitPriceCents,
      taxCode: item.taxCode,
      estimatedCostCents: item.estimatedCostCents,
    }));

async function lockedQuote(
  tx: Prisma.TransactionClient,
  actor: Actor,
  id: string | null,
): Promise<Row> {
  if (!id) throw notFound();
  await lockRow(tx, "quotes", id).catch(() => undefined);
  return requireSameCompany(
    actor,
    await tx.quote.findUnique({ where: { id }, include: { items: true } }),
  );
}

/** Customer, site and job must be this company's and fit together. */
async function partiesProblem(
  db: Prisma.TransactionClient,
  companyId: string,
  input: {
    customerId: string;
    locationId: string | null | undefined;
    jobId: string | null | undefined;
    kind: "quote" | "variation";
  },
): Promise<[string, string] | null> {
  const customer = await db.customer.findFirst({
    where: { id: input.customerId, companyId },
    select: { archivedAt: true },
  });
  if (!customer) return ["customerId", "Choose a customer"];
  if (input.locationId) {
    const site = await db.location.findFirst({
      where: { id: input.locationId, companyId, customerId: input.customerId },
      select: { id: true },
    });
    if (!site) return ["locationId", "Choose one of this customer's sites"];
  }
  if (input.kind === "variation" && !input.jobId)
    return ["jobId", "A variation needs the job it changes"];
  if (input.jobId) {
    const job = await db.job.findFirst({
      where: { id: input.jobId, companyId, customerId: input.customerId },
      select: { status: true },
    });
    if (!job) return ["jobId", "Choose one of this customer's jobs"];
    const problem = acceptProblem({
      status: "sent",
      validUntil: null,
      today: "0000-00-00",
      kind: input.kind,
      jobStatus: job.status,
    });
    if (problem) return ["jobId", problem];
  }
  return null;
}

class JobRace extends Error {}

export function quoteHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const customerId = uuidOrNull(params.get("customerId") ?? "");
    const jobId = uuidOrNull(params.get("jobId") ?? "");
    const where: Prisma.QuoteWhereInput = companyScope(actor, {
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
      ...(jobId ? { jobId } : {}),
    });
    const [rows, total] = await Promise.all([
      db().quote.findMany({
        where,
        include: { items: true },
        orderBy: [{ number: "desc" }, { revision: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().quote.count({ where }),
    ]);
    return privateJson({ page, pageSize: take, total, quotes: rows.map(view) });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id
        ? await db().quote.findUnique({
            where: { id },
            include: { items: true },
          })
        : null,
    );
    return privateJson(view(row));
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateQuote.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    const kind = data.kind ?? "quote";
    const lines = data.lines ?? [];
    const priceEntry = data.priceEntry ?? "exclusive";
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const problem = await partiesProblem(tx, actor.companyId, {
          customerId: data.customerId,
          locationId: data.locationId,
          jobId: data.jobId,
          kind,
        });
        if (problem) throw refuse(400, problem[1], problem[0]);
        const { amounts, totals, estimatedCost } = priced(lines, priceEntry);
        const created = await tx.quote.create({
          data: {
            companyId: actor.companyId,
            kind,
            number: await nextNumber(tx, actor.companyId, "quote"),
            customerId: data.customerId,
            locationId: data.locationId ?? null,
            jobId: data.jobId ?? null,
            title: data.title,
            scope: data.scope ?? null,
            priceEntry,
            validUntil: data.validUntil ? midnight(data.validUntil) : null,
            notes: data.notes ?? null,
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            estimatedCostCents: estimatedCost,
            createdBy: actor.userId,
          },
        });
        await tx.quoteItem.createMany({
          data: itemRows(actor.companyId, created.id, lines, amounts),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.drafted",
          target: { type: "quote", id: created.id },
          after: {
            kind,
            customerId: created.customerId,
            jobId: created.jobId,
            exclusiveCents: totals.exclusive,
          },
        });
        return tx.quote.findUniqueOrThrow({
          where: { id: created.id },
          include: { items: true },
        });
      });
      return privateJson(view(row), { status: 201 });
    });
  };

  /** Edit a draft: header fields and/or the full set of lines. */
  const update: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateQuote.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedQuote(tx, actor, id);
        if (before.status !== "draft")
          throw refuse(409, "A sent quote can't be edited. Revise it instead.");
        const locationId =
          data.locationId === undefined ? before.locationId : data.locationId;
        if (locationId) {
          const site = await tx.location.findFirst({
            where: {
              id: locationId,
              companyId: actor.companyId,
              customerId: before.customerId,
            },
            select: { id: true },
          });
          if (!site)
            throw refuse(
              400,
              "Choose one of this customer's sites",
              "locationId",
            );
        }
        const priceEntry = data.priceEntry ?? before.priceEntry;
        const lines = data.lines ?? linesOf(before);
        const { amounts, totals, estimatedCost } = priced(lines, priceEntry);
        await tx.quoteItem.deleteMany({ where: { quoteId: before.id } });
        await tx.quoteItem.createMany({
          data: itemRows(actor.companyId, before.id, lines, amounts),
        });
        await tx.quote.update({
          where: { id: before.id },
          data: {
            locationId,
            priceEntry,
            ...(data.title !== undefined ? { title: data.title } : {}),
            ...(data.scope !== undefined ? { scope: data.scope } : {}),
            ...(data.notes !== undefined ? { notes: data.notes } : {}),
            ...(data.validUntil !== undefined
              ? {
                  validUntil: data.validUntil
                    ? midnight(data.validUntil)
                    : null,
                }
              : {}),
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            estimatedCostCents: estimatedCost,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.draft_updated",
          target: { type: "quote", id: before.id },
          before: { exclusiveCents: before.exclusiveCents },
          after: { exclusiveCents: totals.exclusive, lines: lines.length },
        });
        return tx.quote.findUniqueOrThrow({
          where: { id: before.id },
          include: { items: true },
        });
      });
      return privateJson(view(row));
    });
  };

  /** Discard a draft (sent quotes are never deleted). */
  const discard: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      await withAudit(db(), async (tx, audit) => {
        const before = await lockedQuote(tx, actor, id);
        if (before.status !== "draft")
          throw refuse(409, "Only a draft can be discarded");
        await tx.quoteItem.deleteMany({ where: { quoteId: before.id } });
        await tx.quote.delete({ where: { id: before.id } });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.draft_discarded",
          target: { type: "quote", id: before.id },
          before: { exclusiveCents: before.exclusiveCents },
        });
      });
      return privateJson({ discarded: true });
    });
  };

  /**
   * Send: price against GST registration on the send date and freeze the
   * quote. Sending a revision supersedes the revision it replaces.
   */
  const send: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Send.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedQuote(tx, actor, id);
        if (before.status !== "draft")
          throw refuse(409, "This quote has already been sent");
        // A revision replaces its predecessor only while that's still open:
        // once accepted, sending the revision would let it convert again.
        if (before.revisesId) {
          await lockRow(tx, "quotes", before.revisesId);
          const predecessor = await tx.quote.findUniqueOrThrow({
            where: { id: before.revisesId },
            select: { status: true },
          });
          if (!["sent", "declined"].includes(predecessor.status))
            throw refuse(
              409,
              `The quote this revises is already ${predecessor.status}`,
            );
        }
        const sentOn = parsed.data.sentOn ?? sydneyToday();
        if (sentOn > sydneyToday())
          throw refuse(400, "The send date can't be in the future", "sentOn");
        const validUntil = asDay(before.validUntil);
        if (validUntil !== null && validUntil < sentOn)
          throw refuse(
            400,
            "Valid until must be on or after the send date",
            "validUntil",
          );
        const lines = linesOf(before);
        if (lines.length === 0)
          throw refuse(400, "Add at least one line", "lines");
        const { registered } = await companyGstStatusOn(
          tx,
          actor.companyId,
          sentOn,
        );
        const taxable = lines.findIndex(
          (line) => line.taxCode === "TAXABLE_10",
        );
        if (!registered && taxable >= 0)
          throw refuse(
            400,
            "Not registered for GST on the send date: no line can be Taxable",
            `lines.${taxable}.taxCode`,
          );
        const { amounts, totals } = priced(
          lines,
          before.priceEntry,
          registered,
        );
        if (totals.inclusive > 1_000_000_000_000n)
          throw refuse(400, "That quote is too large", "lines");
        await tx.quoteItem.deleteMany({ where: { quoteId: before.id } });
        await tx.quoteItem.createMany({
          data: itemRows(actor.companyId, before.id, lines, amounts),
        });
        if (before.revisesId) {
          await tx.quote.updateMany({
            where: { id: before.revisesId, status: "sent" },
            data: { status: "superseded" },
          });
        }
        await tx.quote.update({
          where: { id: before.id },
          data: {
            status: "sent",
            gstRegistered: registered,
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            sentOn: midnight(sentOn),
            sentAt: new Date(),
            sentBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.sent",
          target: { type: "quote", id: before.id },
          after: {
            reference: quoteReference(before.number, before.revision),
            gstRegistered: registered,
            exclusiveCents: totals.exclusive,
            inclusiveCents: totals.inclusive,
          },
        });
        return tx.quote.findUniqueOrThrow({
          where: { id: before.id },
          include: { items: true },
        });
      });
      return privateJson(view(row));
    });
  };

  /** Copy a sent or declined quote into a new draft revision. */
  const revise: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedQuote(tx, actor, id);
        if (!["sent", "declined"].includes(before.status))
          throw refuse(
            409,
            before.status === "draft"
              ? "Edit the draft instead"
              : `A ${before.status} quote can't be revised`,
          );
        const existing = await tx.quote.findFirst({
          where: { companyId: actor.companyId, revisesId: before.id },
          select: { id: true },
        });
        if (existing)
          throw refuse(409, "This quote already has a newer revision");
        const lines = linesOf(before);
        const { amounts, totals, estimatedCost } = priced(
          lines,
          before.priceEntry,
        );
        const created = await tx.quote.create({
          data: {
            companyId: actor.companyId,
            kind: before.kind,
            number: before.number,
            revision: before.revision + 1,
            revisesId: before.id,
            customerId: before.customerId,
            locationId: before.locationId,
            jobId: before.jobId,
            title: before.title,
            scope: before.scope,
            priceEntry: before.priceEntry,
            // A revision gets a new validity date before it is sent.
            validUntil: null,
            notes: before.notes,
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            estimatedCostCents: estimatedCost,
            createdBy: actor.userId,
          },
        });
        await tx.quoteItem.createMany({
          data: itemRows(actor.companyId, created.id, lines, amounts),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.revised",
          target: { type: "quote", id: created.id },
          after: {
            revisesId: before.id,
            reference: quoteReference(created.number, created.revision),
          },
        });
        return tx.quote.findUniqueOrThrow({
          where: { id: created.id },
          include: { items: true },
        });
      });
      return privateJson(view(row), { status: 201 });
    });
  };

  /**
   * Record the customer's acceptance (once) and convert: a quote creates its
   * job, or approves the job it was made for, with estimated revenue = the
   * quote ex GST; a variation adds its ex-GST amount to the job.
   */
  const accept: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Decide.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedQuote(tx, actor, id);
        if (before.jobId) await lockRow(tx, "jobs", before.jobId);
        const job = before.jobId
          ? await tx.job.findUniqueOrThrow({ where: { id: before.jobId } })
          : null;
        const problem = acceptProblem({
          status: before.status as QuoteStatus,
          validUntil: asDay(before.validUntil),
          today: sydneyToday(),
          kind: before.kind,
          jobStatus: job?.status ?? null,
        });
        if (problem) throw refuse(409, problem);
        const revenue = revenueAfterAcceptance(
          job?.agreedPriceExclusiveCents ?? null,
          before.kind,
          before.exclusiveCents,
        );
        let jobId = job?.id ?? null;
        if (!job) {
          const number = await nextNumber(tx, actor.companyId, "job");
          const { jobPrefix } = await tx.company.findUniqueOrThrow({
            where: { id: actor.companyId },
            select: { jobPrefix: true },
          });
          const created = await tx.job.create({
            data: {
              companyId: actor.companyId,
              createdBy: actor.userId,
              number,
              reference: formatJobReference(jobPrefix, number),
              customerId: before.customerId,
              locationId: before.locationId,
              title: before.title,
              description: before.scope,
              agreedPriceExclusiveCents: revenue,
              status: "approved",
            },
          });
          await tx.jobStatusEvent.createMany({
            data: [
              { fromStatus: null, toStatus: "draft" as const },
              { fromStatus: "draft" as const, toStatus: "approved" as const },
            ].map((event) => ({
              ...event,
              companyId: actor.companyId,
              jobId: created.id,
              note: `Accepted quote ${quoteReference(before.number, before.revision)}`,
              createdBy: actor.userId,
            })),
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "job.created",
            target: { type: "job", id: created.id },
            after: {
              reference: created.reference,
              customerId: created.customerId,
              title: created.title,
              agreedPriceExclusiveCents: revenue,
              fromQuoteId: before.id,
            },
          });
          jobId = created.id;
        } else {
          const approve =
            before.kind === "quote" && ["draft", "quoted"].includes(job.status);
          const moved = await tx.job.updateMany({
            where: { id: job.id, status: job.status },
            data: {
              agreedPriceExclusiveCents: revenue,
              ...(approve ? { status: "approved" } : {}),
            },
          });
          if (moved.count !== 1) throw new JobRace();
          if (approve)
            await tx.jobStatusEvent.create({
              data: {
                companyId: actor.companyId,
                jobId: job.id,
                fromStatus: job.status,
                toStatus: "approved",
                note: `Accepted quote ${quoteReference(before.number, before.revision)}`,
                createdBy: actor.userId,
              },
            });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "job.updated",
            target: { type: "job", id: job.id },
            before: {
              agreedPriceExclusiveCents: job.agreedPriceExclusiveCents,
              status: job.status,
            },
            after: {
              agreedPriceExclusiveCents: revenue,
              status: approve ? "approved" : job.status,
              fromQuoteId: before.id,
            },
          });
        }
        await tx.quote.update({
          where: { id: before.id },
          data: {
            status: "accepted",
            jobId,
            decidedAt: new Date(),
            decidedBy: actor.userId,
            decisionNote: parsed.data.note ?? null,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.accepted",
          target: { type: "quote", id: before.id },
          after: {
            jobId,
            exclusiveCents: before.exclusiveCents,
            jobRevenueExclusiveCents: revenue,
          },
        });
        return tx.quote.findUniqueOrThrow({
          where: { id: before.id },
          include: { items: true },
        });
      }).catch((error: unknown) => {
        if (error instanceof JobRace)
          throw refuse(409, "The job changed meanwhile. Reload and try again.");
        throw error;
      });
      return privateJson(view(row));
    });
  };

  /** Record that the customer declined (final; revise to quote again). */
  const decline: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Decide.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedQuote(tx, actor, id);
        if (before.status !== "sent")
          throw refuse(409, `A ${before.status} quote can't be declined`);
        const updated = await tx.quote.update({
          where: { id: before.id },
          data: {
            status: "declined",
            decidedAt: new Date(),
            decidedBy: actor.userId,
            decisionNote: parsed.data.note ?? null,
          },
          include: { items: true },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "quote.declined",
          target: { type: "quote", id: before.id },
          after: { note: parsed.data.note ?? null },
        });
        return updated;
      });
      return privateJson(view(row));
    });
  };

  return { list, read, create, update, discard, send, revise, accept, decline };
}
