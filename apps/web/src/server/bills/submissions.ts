import {
  type Actor,
  companyScope,
  notFound,
  requireSameCompany,
} from "@jobflow/authz";
import { TAX_CODES, billLineProblem } from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { sydneyToday, toDay } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
import { lockDocumentClaim } from "../documents/claim";
import { optionalText, requiredText, uuidOrNull } from "../http/fields";
import { parsePage } from "../http/guards";
import { inTransaction } from "../jobs/handlers";
import { Line, fail, recordBill, refuse } from "./handlers";

/**
 * Subcontractor bills (#139). A subcontractor submits their own tax invoice
 * against one of their accepted offers; the office verifies the evidence
 * and approves (recording the supplier bill once, the #46 snapshot) or
 * rejects it, saying why. What a subcontractor sees is only their own
 * invoice: never the job's price, committed cost or profit (T03).
 */
type IdContext = { params: Promise<{ id: string }> };
const day = z.iso.date("Use a date like 2026-07-01");
/** Pending submissions per contractor: keeps the office queue usable. */
export const MAX_PENDING = 20;

const Submit = z.object({
  offerId: z.uuid({ error: "Choose one of your accepted offers" }),
  supplierReference: requiredText(100, "Enter your invoice number"),
  issuedOn: day,
  dueOn: day.nullable().optional(),
  lines: z
    .array(Line)
    .min(1, "Add at least one line")
    .max(100, "At most 100 lines"),
  documentId: z.uuid({ error: "Attach your tax invoice" }),
  note: optionalText(500).optional(),
});

const Approve = z.object({
  /** The office checked the attached document is a valid tax invoice. */
  evidenceVerified: z.boolean(),
  creditableBasisPoints: z
    .number()
    .int()
    .min(0, "Between 0% and 100%")
    .max(10_000, "Between 0% and 100%")
    .default(10_000),
  creditableReason: optionalText(500).optional(),
  dueOn: day.nullable().optional(),
  note: optionalText(500).optional(),
});
const Reject = z.object({
  note: requiredText(500, "Say what needs to change"),
});

const INCLUDE = {
  items: { orderBy: { position: "asc" } },
  acceptance: {
    select: {
      offer: {
        select: {
          scope: true,
          job: { select: { reference: true, title: true } },
        },
      },
    },
  },
} as const satisfies Prisma.SubcontractorBillSubmissionInclude;
type Row = Prisma.SubcontractorBillSubmissionGetPayload<{
  include: typeof INCLUDE;
}>;

const money = (value: bigint) => value.toString();

/**
 * The subcontractor's view: their own invoice and its decision. Deliberately
 * built field by field so no job price, committed cost or bill snapshot
 * (job cost, GST claim) can leak in.
 */
function ownView(row: Row) {
  const lines = row.items.map((item) => ({
    description: item.description,
    taxCode: item.taxCode,
    exclusiveCents: money(item.exclusiveCents),
    gstCents: money(item.gstCents),
  }));
  const total = row.items.reduce(
    (sum, item) => sum + item.exclusiveCents + item.gstCents,
    0n,
  );
  return {
    id: row.id,
    offerId: row.offerId,
    job: {
      reference: row.acceptance.offer.job.reference,
      title: row.acceptance.offer.job.title,
    },
    scope: row.acceptance.offer.scope,
    supplierReference: row.supplierReference,
    issuedOn: toDay(row.issuedOn),
    dueOn: row.dueOn ? toDay(row.dueOn) : null,
    lines,
    totalCents: money(total),
    note: row.note,
    status: row.status,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

type OfficeRow = Row & {
  contractor: { name: string };
  acceptance: { inclusiveCents: bigint; committedCostCents: bigint };
};

/**
 * The office view adds the agreed offer amount and what's already billed
 * against the offer, so the reviewer can see an inflated or repeated
 * invoice before approving.
 */
function officeView(row: OfficeRow, billedInclusive: bigint) {
  return {
    ...ownView(row),
    contractorId: row.contractorId,
    contractorName: row.contractor.name,
    jobId: row.jobId,
    documentId: row.documentId,
    submittedBy: row.submittedBy,
    decidedBy: row.decidedBy,
    billId: row.billId,
    offer: {
      agreedInclusiveCents: money(row.acceptance.inclusiveCents),
      billedInclusiveCents: money(billedInclusive),
    },
  };
}

/** Live bills' totals (incl GST) per offer. */
async function billedByOffer(
  db: Prisma.TransactionClient | PrismaClient,
  companyId: string,
  offerIds: readonly string[],
) {
  const rows = await db.supplierBill.groupBy({
    by: ["offerId"],
    where: { companyId, offerId: { in: [...offerIds] }, voidedAt: null },
    _sum: { inclusiveCents: true },
  });
  return new Map(
    rows.map((row) => [row.offerId!, row._sum.inclusiveCents ?? 0n]),
  );
}

const OFFICE_INCLUDE = {
  ...INCLUDE,
  contractor: { select: { name: true } },
  acceptance: {
    select: {
      inclusiveCents: true,
      committedCostCents: true,
      offer: {
        select: {
          scope: true,
          job: { select: { reference: true, title: true } },
        },
      },
    },
  },
} as const;

async function ownContractor(
  db: Prisma.TransactionClient | PrismaClient,
  actor: Actor,
) {
  if (actor.role !== "subcontractor") throw notFound();
  return db.contractor.findFirst({
    where: { companyId: actor.companyId, userId: actor.userId },
  });
}

export function billSubmissionHandlers(db: () => PrismaClient) {
  /** A subcontractor submits their own invoice for an accepted offer. */
  const submit: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = Submit.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    if (data.issuedOn > sydneyToday())
      return fail(400, "The invoice date can't be in the future", "issuedOn");
    if (data.dueOn && data.dueOn < data.issuedOn)
      return fail(400, "Due on or after the invoice date", "dueOn");
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const found = await ownContractor(tx, actor);
          if (!found)
            throw refuse(
              400,
              "Your contractor profile isn't active",
              "offerId",
            );
          // Lock order as bills: contractor, then job, then document. Re-read
          // under the lock so archiving or a GST change can't race this.
          await lockRow(tx, "contractors", found.id);
          const contractor = await tx.contractor.findUniqueOrThrow({
            where: { id: found.id },
          });
          if (contractor.archivedAt)
            throw refuse(
              400,
              "Your contractor profile isn't active",
              "offerId",
            );
          const pending = await tx.subcontractorBillSubmission.count({
            where: {
              companyId: actor.companyId,
              contractorId: contractor.id,
              status: "submitted",
            },
          });
          if (pending >= MAX_PENDING)
            throw refuse(
              409,
              `You have ${MAX_PENDING} invoices waiting for the office; wait for a decision first`,
            );
          const acceptance = await tx.contractorAcceptance.findFirst({
            where: {
              companyId: actor.companyId,
              offerId: data.offerId,
              contractorId: contractor.id,
            },
            select: { jobId: true, offerId: true },
          });
          if (!acceptance)
            throw refuse(400, "Choose one of your accepted offers", "offerId");
          await lockRow(tx, "jobs", acceptance.jobId);
          data.lines.forEach((line, index) => {
            const problem = billLineProblem(
              {
                taxCode: line.taxCode as (typeof TAX_CODES)[number],
                exclusive: line.exclusiveCents,
                gst: line.gstCents,
              },
              contractor.gstRegistered,
            );
            if (problem) throw refuse(400, problem, `lines.${index}`);
          });
          const total = data.lines.reduce(
            (sum, line) => sum + line.exclusiveCents + line.gstCents,
            0n,
          );
          if (total <= 0n)
            throw refuse(400, "An invoice must be for more than $0", "lines");
          if (total > 1_000_000_000_000n)
            throw refuse(400, "That invoice is too large", "lines");
          const document = await lockDocumentClaim(
            tx,
            actor.companyId,
            data.documentId,
          );
          if (
            !document ||
            document.createdBy !== actor.userId ||
            !["tax_invoice", "receipt"].includes(document.kind)
          )
            throw refuse(
              400,
              "Attach the tax invoice you uploaded",
              "documentId",
            );
          if (
            document.expense ||
            document.workEvidence ||
            document.supplierBill ||
            document.supplierCredit ||
            document.billSubmission
          )
            throw refuse(
              400,
              "That document is already attached to another record",
              "documentId",
            );
          const recorded = await tx.supplierBill.findFirst({
            where: {
              companyId: actor.companyId,
              contractorId: contractor.id,
              voidedAt: null,
              supplierReference: {
                equals: data.supplierReference,
                mode: "insensitive",
              },
            },
            select: { id: true },
          });
          if (recorded)
            throw refuse(
              409,
              "This invoice is already recorded",
              "supplierReference",
            );
          const created = await tx.subcontractorBillSubmission.create({
            data: {
              companyId: actor.companyId,
              contractorId: contractor.id,
              offerId: acceptance.offerId,
              jobId: acceptance.jobId,
              supplierReference: data.supplierReference,
              issuedOn: new Date(`${data.issuedOn}T00:00:00Z`),
              dueOn: data.dueOn ? new Date(`${data.dueOn}T00:00:00Z`) : null,
              documentId: data.documentId,
              note: data.note ?? null,
              submittedBy: actor.userId,
            },
          });
          await tx.subcontractorBillSubmissionItem.createMany({
            data: data.lines.map((line, index) => ({
              companyId: actor.companyId,
              submissionId: created.id,
              position: index + 1,
              description: line.description,
              taxCode: line.taxCode,
              exclusiveCents: line.exclusiveCents,
              gstCents: line.gstCents,
            })),
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "bill_submission.submitted",
            target: { type: "bill_submission", id: created.id },
            after: {
              offerId: acceptance.offerId,
              documentId: data.documentId,
              totalCents: total,
            },
          });
          return tx.subcontractorBillSubmission.findUniqueOrThrow({
            where: { id: created.id },
            include: INCLUDE,
          });
        });
        return privateJson(ownView(row), { status: 201 });
      });
    } catch (error) {
      if (isUniqueViolation(error, "pending_reference_key"))
        return fail(
          409,
          "You've already submitted this invoice",
          "supplierReference",
        );
      throw error;
    }
  };

  /** The signed-in subcontractor's own submissions, newest first. */
  const mine: PolicyHandler<unknown> = async ({ actor, request }) => {
    const contractor = await ownContractor(db(), actor);
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    if (!contractor)
      return privateJson({
        page,
        pageSize: take,
        total: 0,
        gstRegistered: false,
        submissions: [],
      });
    const offerId = uuidOrNull(params.get("offerId") ?? "");
    const where = {
      companyId: actor.companyId,
      contractorId: contractor.id,
      ...(offerId ? { offerId } : {}),
    };
    const [rows, total] = await Promise.all([
      db().subcontractorBillSubmission.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().subcontractorBillSubmission.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      // Their own current registration decides which lines they can send.
      gstRegistered: contractor.gstRegistered,
      submissions: rows.map(ownView),
    });
  };

  /** The office queue (default: waiting for a decision). */
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const status = z
      .enum(["submitted", "approved", "rejected"])
      .catch("submitted")
      .parse(params.get("status") ?? "submitted");
    const { page, take, skip } = parsePage(params);
    const where = { ...companyScope(actor), status };
    const [rows, total] = await Promise.all([
      db().subcontractorBillSubmission.findMany({
        where,
        include: OFFICE_INCLUDE,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().subcontractorBillSubmission.count({ where }),
    ]);
    const billed = await billedByOffer(
      db(),
      actor.companyId,
      rows.map((row) => row.offerId),
    );
    return privateJson({
      page,
      pageSize: take,
      total,
      submissions: rows.map((row) =>
        officeView(row, billed.get(row.offerId) ?? 0n),
      ),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    if (!id) throw notFound();
    const row = requireSameCompany(
      actor,
      await db().subcontractorBillSubmission.findUnique({
        where: { id },
        include: OFFICE_INCLUDE,
      }),
    );
    const billed = await billedByOffer(db(), actor.companyId, [row.offerId]);
    return privateJson(officeView(row, billed.get(row.offerId) ?? 0n));
  };

  /** Lock a waiting submission in the actor's company. */
  async function lockedPending(
    tx: Prisma.TransactionClient,
    actor: Actor,
    id: string,
  ) {
    await lockRow(tx, "subcontractor_bill_submissions", id);
    const row = requireSameCompany(
      actor,
      await tx.subcontractorBillSubmission.findUnique({
        where: { id },
        include: { items: { orderBy: { position: "asc" } } },
      }),
    );
    if (row.status !== "submitted")
      throw refuse(409, `This invoice is already ${row.status}`);
    return row;
  }

  /** Approve: record the supplier bill once, from the submitted invoice. */
  const approve: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Approve.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    if (!id) throw notFound();
    const decision = parsed.data;
    if (decision.creditableBasisPoints < 10_000 && !decision.creditableReason)
      return fail(
        400,
        "Say why only part of the GST is claimable",
        "creditableReason",
      );
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const submission = await lockedPending(tx, actor, id);
          const dueOn =
            decision.dueOn === undefined
              ? submission.dueOn
                ? toDay(submission.dueOn)
                : null
              : decision.dueOn;
          if (dueOn && dueOn < toDay(submission.issuedOn))
            throw refuse(400, "Due on or after the bill date", "dueOn");
          const bill = await recordBill(
            tx,
            audit,
            actor,
            {
              contractorId: submission.contractorId,
              offerId: submission.offerId,
              jobId: submission.jobId,
              supplierReference: submission.supplierReference,
              issuedOn: toDay(submission.issuedOn),
              dueOn,
              lines: submission.items.map((item) => ({
                description: item.description,
                taxCode: item.taxCode,
                exclusiveCents: item.exclusiveCents,
                gstCents: item.gstCents,
              })),
              documentId: submission.documentId,
              evidenceVerified: decision.evidenceVerified,
              creditableBasisPoints: decision.creditableBasisPoints,
              ...(decision.creditableReason
                ? { creditableReason: decision.creditableReason }
                : {}),
              ...(decision.note ? { note: decision.note } : {}),
            },
            { submissionId: submission.id },
          );
          await tx.subcontractorBillSubmission.update({
            where: { id },
            data: {
              status: "approved",
              decidedAt: new Date(),
              decidedBy: actor.userId,
              billId: bill.id,
              // The approval note is the bill's internal note: never shown
              // to the subcontractor (only a rejection's note is).
              decisionNote: null,
            },
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "bill_submission.approved",
            target: { type: "bill_submission", id },
            after: {
              billId: bill.id,
              evidenceVerified: decision.evidenceVerified,
            },
          });
          return tx.subcontractorBillSubmission.findUniqueOrThrow({
            where: { id },
            include: OFFICE_INCLUDE,
          });
        });
        const billed = await billedByOffer(db(), actor.companyId, [
          row.offerId,
        ]);
        return privateJson(officeView(row, billed.get(row.offerId) ?? 0n));
      });
    } catch (error) {
      if (isUniqueViolation(error, "_reference_key"))
        return fail(
          409,
          "This supplier invoice is already recorded",
          "supplierReference",
        );
      throw error;
    }
  };

  /** Reject, saying what needs to change; the subcontractor can resubmit. */
  const reject: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Reject.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    if (!id) throw notFound();
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        await lockedPending(tx, actor, id);
        await tx.subcontractorBillSubmission.update({
          where: { id },
          data: {
            status: "rejected",
            decidedAt: new Date(),
            decidedBy: actor.userId,
            decisionNote: parsed.data.note,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "bill_submission.rejected",
          target: { type: "bill_submission", id },
          after: { note: parsed.data.note },
        });
        return tx.subcontractorBillSubmission.findUniqueOrThrow({
          where: { id },
          include: OFFICE_INCLUDE,
        });
      });
      const billed = await billedByOffer(db(), actor.companyId, [row.offerId]);
      return privateJson(officeView(row, billed.get(row.offerId) ?? 0n));
    });
  };

  return { submit, mine, list, read, approve, reject };
}
