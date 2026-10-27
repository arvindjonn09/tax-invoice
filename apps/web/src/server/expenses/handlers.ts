import {
  type Actor,
  can,
  companyScope,
  requireSameCompany,
} from "@jobflow/authz";
import {
  EXPENSE_CATEGORIES,
  TAX_CODES,
  type TaxCode,
  expenseCost,
  expenseLine,
  hasPurchaseEvidence,
  percentToBasisPoints,
  reverseExpense,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Expense,
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { companyGstStatusOn, sydneyToday, toDay } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
import { lockDocumentClaim } from "../documents/claim";
import {
  defined,
  optionalText,
  requiredText,
  uuidOrNull,
} from "../http/fields";
import { parsePage } from "../http/guards";
import { Refusal, inTransaction } from "../jobs/handlers";

// #40. Submit: expense.submit_own (owner, manager, employee); employees only
// for jobs they're assigned to. Read all and decide: expense.read_all /
// expense.approve (office). Cost is incurred once, on approval, from a
// snapshot; decided expenses are final and corrected by a reversal.

/** Whole cents, 0 to $10 billion (number or digit string). */
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

const percent = z
  .string()
  .trim()
  .transform((value, context) => {
    try {
      return Number(percentToBasisPoints(value));
    } catch {
      context.addIssue({ code: "custom", message: "Enter 0 to 100" });
      return z.NEVER;
    }
  });

const day = z.iso.date("Use a date like 2026-07-01");

const expenseFields = {
  jobId: z.uuid().nullable(),
  category: z.enum(EXPENSE_CATEGORIES),
  description: requiredText(500, "Describe the expense"),
  supplierName: optionalText(200),
  purchasedOn: day,
  priceEntry: z.enum(["exclusive", "inclusive"]),
  amountCents: cents,
  taxCode: z.enum(TAX_CODES as [TaxCode, ...TaxCode[]]),
  creditablePercent: percent,
  receiptDocumentId: z.uuid().nullable(),
  settlement: z.enum(["paid_at_purchase", "on_account"]),
  paidOn: day.nullable(),
  paymentMethod: z.enum(["card", "cash", "bank_transfer", "other"]).nullable(),
};
const CreateExpense = z
  .object({
    ...expenseFields,
    /**
     * Correct an approved expense whose cost-only reversal is approved: the
     * replacement reuses the original's settlement (its single payment or
     * payable) instead of recording a new one.
     */
    correctsExpenseId: z.uuid(),
  })
  .partial()
  .required({
    category: true,
    description: true,
    purchasedOn: true,
    priceEntry: true,
    amountCents: true,
    taxCode: true,
  });
const UpdateExpense = z
  .object(expenseFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
const Decide = z.object({
  decision: z.enum(["approve", "reject"]),
  note: optionalText(500).optional(),
  /** The approver checked the attached document (R5/R6); never inferred. */
  evidenceVerified: z.boolean().optional(),
});
/**
 * A reversal corrects cost and GST only. Cash or the supplier balance moves
 * only when an actual refund or supplier credit is recorded with it.
 */
const Reverse = z.object({
  note: requiredText(500, "Say why it's reversed"),
  settlement: z.enum(["none", "refund", "supplier_credit"]).default("none"),
  refundedOn: day.optional(),
  paymentMethod: z.enum(["card", "cash", "bank_transfer", "other"]).optional(),
});

const STATUS = z
  .enum(["submitted", "approved", "rejected"])
  .optional()
  .catch(undefined);

type IdContext = { params: Promise<{ id: string }> };

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    { status },
  );

const money = (value: bigint | null) =>
  value === null ? null : value.toString();
const fromDay = (value: string) => new Date(`${value}T00:00:00Z`);

/** What the submitter entered and its status: no cost or credit split. */
function ownView(row: Expense) {
  return {
    id: row.id,
    jobId: row.jobId,
    category: row.category,
    description: row.description,
    supplierName: row.supplierName,
    purchasedOn: toDay(row.purchasedOn),
    priceEntry: row.priceEntry,
    amountCents: money(row.enteredAmountCents),
    taxCode: row.taxCode,
    exclusiveCents: money(row.exclusiveCents),
    gstCents: money(row.gstCents),
    inclusiveCents: money(row.inclusiveCents),
    creditablePercent: (row.creditableBasisPoints / 100).toString(),
    receiptDocumentId: row.receiptDocumentId,
    settlement: row.settlement,
    paidOn: row.paidOn ? toDay(row.paidOn) : null,
    paymentMethod: row.paymentMethod,
    status: row.status,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt,
    reversesId: row.reversesId,
    createdAt: row.createdAt,
  };
}

type OfficeRow = Expense & {
  reversedBy: { id: string; settlement: Expense["settlement"] } | null;
  corrections: { id: string; status: string }[];
  supplierPaymentAllocations: { amountCents: bigint }[];
};

/**
 * What is still owed to the supplier on an approved on-account expense
 * (#141), or null when nothing is owed on account (paid at purchase,
 * reversals, not yet approved, or cancelled by a supplier credit).
 */
function supplierBalance(row: OfficeRow) {
  if (
    row.status !== "approved" ||
    row.settlement !== "on_account" ||
    row.reversesId ||
    row.reversedBy?.settlement === "on_account"
  )
    return null;
  const paid = row.supplierPaymentAllocations.reduce(
    (total, allocation) => total + allocation.amountCents,
    0n,
  );
  const owing = row.inclusiveCents - paid;
  return {
    paidCents: paid.toString(),
    outstandingCents: (owing < 0n ? 0n : owing).toString(),
  };
}

/** Whether live supplier payments are allocated to an on-account expense. */
async function livePayments(
  tx: Prisma.TransactionClient,
  companyId: string,
  expenseId: string,
): Promise<boolean> {
  return (
    (await tx.supplierPaymentExpenseAllocation.count({
      where: { companyId, expenseId, payment: { voidedAt: null } },
    })) > 0
  );
}

/** Office view: adds who submitted/decided and the approval snapshot. */
function officeView(row: OfficeRow) {
  return {
    ...ownView(row),
    submittedBy: row.submittedBy,
    decidedBy: row.decidedBy,
    reversedById: row.reversedBy?.id ?? null,
    supplierBalance: supplierBalance(row),
    correctsId: row.correctsId,
    correctedById:
      row.corrections.find((c) => c.status !== "rejected")?.id ?? null,
    approval:
      row.jobCostCents === null
        ? null
        : {
            companyGstRegistered: row.companyGstRegistered,
            evidenceVerified: row.evidenceVerified,
            hasEvidence: row.hasEvidence,
            creditableGstCents: money(row.creditableGstCents),
            nonCreditableGstCents: money(row.nonCreditableGstCents),
            jobCostCents: money(row.jobCostCents),
          },
  };
}

const OFFICE_INCLUDE = {
  reversedBy: { select: { id: true, settlement: true } },
  corrections: { select: { id: true, status: true } },
  supplierPaymentAllocations: {
    where: { payment: { voidedAt: null } },
    select: { amountCents: true },
  },
} as const;

type Draft = {
  jobId: string | null;
  purchasedOn: string;
  priceEntry: "exclusive" | "inclusive";
  amountCents: bigint;
  taxCode: TaxCode;
  creditableBasisPoints: number;
  receiptDocumentId: string | null;
  settlement: "paid_at_purchase" | "on_account";
  paidOn: string | null;
  paymentMethod: "card" | "cash" | "bank_transfer" | "other" | null;
};

/**
 * Checks shared by create and edit. Returns a field error, or the columns to
 * write (amounts recalculated from the entered value).
 */
async function checkDraft(
  db: Prisma.TransactionClient,
  actor: Actor,
  draft: Draft,
  expenseId?: string,
): Promise<[string, string] | Prisma.ExpenseUncheckedUpdateInput> {
  if (draft.purchasedOn > sydneyToday())
    return ["purchasedOn", "The purchase date can't be in the future"];
  const office = can(actor.role, "expense.read_all");
  if (draft.jobId) {
    const job = await db.job.findFirst({
      where: { id: draft.jobId, companyId: actor.companyId },
      select: { id: true },
    });
    if (!job) return ["jobId", "Choose a job"];
    if (!office) {
      const assigned = await db.assignment.findFirst({
        where: {
          companyId: actor.companyId,
          jobId: job.id,
          endedAt: null,
          employee: { userId: actor.userId, isActive: true },
        },
        select: { id: true },
      });
      if (!assigned) return ["jobId", "Choose one of your assigned jobs"];
    }
  } else if (!office) {
    return ["jobId", "Choose one of your assigned jobs"];
  }
  if (draft.receiptDocumentId) {
    // Under the document lock bills share, so one receipt never backs both.
    const document = await lockDocumentClaim(
      db,
      actor.companyId,
      draft.receiptDocumentId,
    );
    const visible =
      document &&
      (document.createdBy === actor.userId ||
        can(actor.role, "document.read_all"));
    if (!visible || !["receipt", "tax_invoice"].includes(document.kind))
      return ["receiptDocumentId", "Attach one of your uploaded receipts"];
    if (document.expense && document.expense.id !== expenseId)
      return [
        "receiptDocumentId",
        "That receipt is already attached to another expense",
      ];
    if (
      document.supplierBill ||
      document.supplierCredit ||
      document.billSubmission
    )
      return [
        "receiptDocumentId",
        "That document is already attached to a supplier bill or credit",
      ];
  }
  if (draft.settlement === "paid_at_purchase") {
    if (!draft.paymentMethod)
      return ["paymentMethod", "Choose how it was paid"];
    if ((draft.paidOn ?? draft.purchasedOn) > sydneyToday())
      return ["paidOn", "The payment date can't be in the future"];
  } else if (draft.paidOn || draft.paymentMethod) {
    return ["settlement", "An expense on account has no payment yet"];
  }
  const line = expenseLine({
    amount: draft.amountCents,
    priceEntry: draft.priceEntry,
    taxCode: draft.taxCode,
  });
  return {
    jobId: draft.jobId,
    purchasedOn: fromDay(draft.purchasedOn),
    priceEntry: draft.priceEntry,
    enteredAmountCents: draft.amountCents,
    taxCode: draft.taxCode,
    gstRateBasisPoints: Number(line.rateBasisPoints),
    exclusiveCents: line.exclusive,
    gstCents: line.gst,
    inclusiveCents: line.inclusive,
    creditableBasisPoints: draft.creditableBasisPoints,
    receiptDocumentId: draft.receiptDocumentId,
    settlement: draft.settlement,
    paidOn:
      draft.settlement === "paid_at_purchase"
        ? fromDay(draft.paidOn ?? draft.purchasedOn)
        : null,
    paymentMethod:
      draft.settlement === "paid_at_purchase" ? draft.paymentMethod : null,
  };
}

const RECEIPT_TAKEN = "That receipt is already attached to another expense";
const ALREADY_CORRECTED = "That expense already has a correction";

/**
 * A correction replaces an approved expense whose cost-only reversal is
 * approved, reusing the original's settlement: the one real payment (or
 * supplier balance) stays the only one. It must keep the paid GST-inclusive
 * total — a different total means money moved, which is recorded as a
 * refund/credit on the reversal or as a separate expense. Office only.
 */
async function correctionOf(
  tx: Prisma.TransactionClient,
  actor: Actor,
  originalId: string,
  checked: Prisma.ExpenseUncheckedUpdateInput,
): Promise<{
  correctsId: string;
  settlement: null;
  paidOn: null;
  paymentMethod: null;
}> {
  const field = "correctsExpenseId";
  if (!can(actor.role, "expense.read_all"))
    throw new Refusal(
      fail(400, "Only the office can correct an expense", field),
    );
  await lockRow(tx, "expenses", originalId);
  const original = requireSameCompany(
    actor,
    await tx.expense.findUnique({
      where: { id: originalId },
      include: {
        reversedBy: true,
        corrections: {
          where: { status: { not: "rejected" } },
          select: { id: true },
        },
      },
    }),
  );
  if (
    original.status !== "approved" ||
    original.reversesId ||
    original.correctsId
  )
    throw new Refusal(
      fail(409, "Only an approved, original expense can be corrected", field),
    );
  // A rejected correction is history; only a live one blocks a new attempt.
  if (original.corrections.length > 0)
    throw new Refusal(fail(409, ALREADY_CORRECTED, field));
  if (!original.reversedBy || original.reversedBy.settlement !== null)
    throw new Refusal(
      fail(
        409,
        "Reverse the expense's cost first (without a refund or credit), then correct it",
        field,
      ),
    );
  if (
    original.settlement === "on_account" &&
    (await livePayments(tx, actor.companyId, original.id))
  )
    throw new Refusal(
      fail(
        409,
        "Supplier payments are allocated to this expense; void them first",
        field,
      ),
    );
  if (checked.inclusiveCents !== original.inclusiveCents)
    throw new Refusal(
      fail(
        400,
        "A correction keeps the amount actually paid. Record a refund or a separate expense for any difference.",
        "amountCents",
      ),
    );
  return {
    correctsId: original.id,
    settlement: null,
    paidOn: null,
    paymentMethod: null,
  };
}

/**
 * Take the locks that assignment and deactivation writes take (#32: job,
 * then employee) before re-checking a submitter's eligibility, so an
 * assignment ending or an employee deactivating can't slip in between the
 * check and the insert.
 */
async function lockEligibility(
  tx: Prisma.TransactionClient,
  actor: Actor,
  jobId: string | null,
) {
  const job = jobId ? uuidOrNull(jobId) : null;
  if (job) await lockRow(tx, "jobs", job);
  if (can(actor.role, "expense.read_all")) return;
  const employee = await tx.employee.findFirst({
    where: { companyId: actor.companyId, userId: actor.userId },
    select: { id: true },
  });
  if (employee) await lockRow(tx, "employees", employee.id);
}

async function lockedExpense(tx: Prisma.TransactionClient, id: string) {
  await lockRow(tx, "expenses", id);
  return tx.expense.findUniqueOrThrow({
    where: { id },
    include: OFFICE_INCLUDE,
  });
}

async function ownExpense(db: PrismaClient, actor: Actor, id: string) {
  const safe = uuidOrNull(id);
  return requireSameCompany(
    actor,
    safe ? await db.expense.findUnique({ where: { id: safe } }) : null,
  );
}

/** Value equality for Prisma scalars (Dates, bigints, strings, null). */
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

export function expenseHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const jobId = uuidOrNull(params.get("jobId") ?? "");
    const filter: Prisma.ExpenseWhereInput = {
      ...(status ? { status } : {}),
      ...(params.get("jobId") === "none"
        ? { jobId: null }
        : jobId
          ? { jobId }
          : {}),
    };
    const where: Prisma.ExpenseWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().expense.findMany({
        where,
        include: OFFICE_INCLUDE,
        orderBy: [
          { purchasedOn: "desc" },
          { createdAt: "desc" },
          { id: "asc" },
        ],
        take,
        skip,
      }),
      db().expense.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      expenses: rows.map(officeView),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const owned = await ownExpense(db(), actor, (await context.params).id);
    const row = await db().expense.findUniqueOrThrow({
      where: { id: owned.id },
      include: OFFICE_INCLUDE,
    });
    return privateJson(officeView(row));
  };

  /** The caller's own submissions (newest first). */
  const mine: PolicyHandler<unknown> = async ({ actor, request }) => {
    const { page, take, skip } = parsePage(new URL(request.url).searchParams);
    const where = {
      companyId: actor.companyId,
      submittedBy: actor.userId,
      reversesId: null,
    };
    const [rows, total] = await Promise.all([
      db().expense.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().expense.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      expenses: rows.map(ownView),
    });
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateExpense.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = defined(parsed.data);
    const { defaultExpenseSettlement } = await db().company.findUniqueOrThrow({
      where: { id: actor.companyId },
      select: { defaultExpenseSettlement: true },
    });
    const jobId = data.jobId ?? null;
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          // Eligibility is checked under the locks, not on a stale preflight.
          await lockEligibility(tx, actor, jobId);
          const checked = await checkDraft(tx, actor, {
            jobId,
            purchasedOn: data.purchasedOn,
            priceEntry: data.priceEntry,
            amountCents: data.amountCents,
            taxCode: data.taxCode,
            creditableBasisPoints: data.creditablePercent ?? 10_000,
            receiptDocumentId: data.receiptDocumentId ?? null,
            settlement: data.settlement ?? defaultExpenseSettlement,
            paidOn: data.paidOn ?? null,
            paymentMethod: data.paymentMethod ?? null,
          });
          if (Array.isArray(checked))
            throw new Refusal(fail(400, checked[1], checked[0]));
          const correction = data.correctsExpenseId
            ? await correctionOf(tx, actor, data.correctsExpenseId, checked)
            : {};
          const created = await tx.expense.create({
            data: {
              ...(checked as Prisma.ExpenseUncheckedCreateInput),
              ...correction,
              companyId: actor.companyId,
              category: data.category,
              description: data.description,
              supplierName: data.supplierName ?? null,
              submittedBy: actor.userId,
            },
            include: OFFICE_INCLUDE,
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "expense.submitted",
            target: { type: "expense", id: created.id },
            after: {
              jobId: created.jobId,
              category: created.category,
              taxCode: created.taxCode,
              exclusiveCents: created.exclusiveCents,
              gstCents: created.gstCents,
              settlement: created.settlement,
              correctsId: created.correctsId,
            },
          });
          return created;
        });
        return privateJson(
          can(actor.role, "expense.read_all") ? officeView(row) : ownView(row),
          { status: 201 },
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, "receipt_document_id"))
        return fail(400, RECEIPT_TAKEN, "receiptDocumentId");
      if (isUniqueViolation(error, "live_correction"))
        return fail(409, ALREADY_CORRECTED, "correctsExpenseId");
      throw error;
    }
  };

  /**
   * The submitter edits their own expense while it awaits a decision; once
   * approved or rejected it is final (409; the database refuses it too).
   */
  const update: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = UpdateExpense.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownExpense(db(), actor, (await context.params).id);
    // Someone else's expense is "not found", even for office roles.
    if (owned.submittedBy !== actor.userId) requireSameCompany(actor, null);
    const data = defined(parsed.data);
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const before = await lockedExpense(tx, owned.id);
          if (before.status !== "submitted")
            throw new Refusal(
              fail(
                409,
                `An ${before.status} expense can't be changed. Ask the office to reverse it.`,
              ),
            );
          if (before.correctsId)
            throw new Refusal(
              fail(
                409,
                "A correction can't be edited. Reject it and submit a new correction.",
              ),
            );
          const settlement = data.settlement ?? before.settlement;
          const keepPayment = settlement === before.settlement;
          const nextJobId =
            data.jobId === undefined ? before.jobId : data.jobId;
          await lockEligibility(tx, actor, nextJobId);
          if (!settlement) throw new Error("Only reversals lack a settlement");
          const checked = await checkDraft(
            tx,
            actor,
            {
              jobId: nextJobId,
              purchasedOn: data.purchasedOn ?? toDay(before.purchasedOn),
              priceEntry: data.priceEntry ?? before.priceEntry,
              amountCents: data.amountCents ?? before.enteredAmountCents,
              taxCode: data.taxCode ?? before.taxCode,
              creditableBasisPoints:
                data.creditablePercent ?? before.creditableBasisPoints,
              receiptDocumentId:
                data.receiptDocumentId === undefined
                  ? before.receiptDocumentId
                  : data.receiptDocumentId,
              settlement,
              paidOn:
                data.paidOn !== undefined
                  ? data.paidOn
                  : keepPayment && before.paidOn
                    ? toDay(before.paidOn)
                    : null,
              paymentMethod:
                data.paymentMethod !== undefined
                  ? data.paymentMethod
                  : keepPayment
                    ? before.paymentMethod
                    : null,
            },
            before.id,
          );
          if (Array.isArray(checked))
            throw new Refusal(fail(400, checked[1], checked[0]));
          const next: Record<string, unknown> = {
            ...checked,
            ...(data.category ? { category: data.category } : {}),
            ...(data.description ? { description: data.description } : {}),
            ...(data.supplierName !== undefined
              ? { supplierName: data.supplierName }
              : {}),
          };
          const changed = Object.keys(next).filter(
            (key) => !same(before[key as keyof Expense], next[key]),
          );
          if (changed.length === 0)
            throw new Refusal(privateJson(ownView(before)));
          const updated = await tx.expense.update({
            where: { id: before.id },
            data: Object.fromEntries(changed.map((key) => [key, next[key]])),
            include: OFFICE_INCLUDE,
          });
          const pick = (record: Expense) =>
            Object.fromEntries(
              changed.map((key) => [key, record[key as keyof Expense]]),
            );
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "expense.updated",
            target: { type: "expense", id: before.id },
            before: pick(before),
            after: pick(updated),
          });
          return updated;
        });
        return privateJson(
          can(actor.role, "expense.read_all") ? officeView(row) : ownView(row),
        );
      });
    } catch (error) {
      if (isUniqueViolation(error, "receipt_document_id"))
        return fail(400, RECEIPT_TAKEN, "receiptDocumentId");
      throw error;
    }
  };

  /**
   * Approve or reject a submitted expense. Approval snapshots the creditable
   * GST and job cost once, using the company's GST registration on the
   * purchase date and whether evidence is held (R5, R6).
   */
  const decide: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Decide.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownExpense(db(), actor, (await context.params).id);
    const { decision, note, evidenceVerified = false } = parsed.data;
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedExpense(tx, owned.id);
        if (before.status !== "submitted")
          throw new Refusal(
            fail(409, `This expense is already ${before.status}`),
          );
        const receipt = before.receiptDocumentId
          ? await tx.document.findUniqueOrThrow({
              where: { id: before.receiptDocumentId },
              select: { kind: true },
            })
          : null;
        const document =
          receipt?.kind === "tax_invoice"
            ? "tax_invoice"
            : receipt
              ? "receipt"
              : null;
        if (evidenceVerified && !document)
          throw new Refusal(
            fail(
              400,
              "Attach the receipt or tax invoice before verifying it",
              "evidenceVerified",
            ),
          );
        const decided = {
          decisionNote: note ?? null,
          decidedAt: new Date(),
          decidedBy: actor.userId,
        };
        if (decision === "reject") {
          const updated = await tx.expense.update({
            where: { id: before.id },
            data: { status: "rejected", ...decided },
            include: OFFICE_INCLUDE,
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "expense.rejected",
            target: { type: "expense", id: before.id },
            before: { status: before.status },
            after: { status: updated.status },
          });
          return updated;
        }
        // A correction changes the GST that payments to its on-account
        // original attribute (#141). Hold the original's row (the lock
        // supplier payments take) and refuse while payments are allocated,
        // so a cash-basis claim already made never goes stale.
        if (before.correctsId) {
          await lockRow(tx, "expenses", before.correctsId);
          if (await livePayments(tx, actor.companyId, before.correctsId))
            throw new Refusal(
              fail(
                409,
                "Supplier payments are allocated to the original expense; void them first",
              ),
            );
        }
        const company = await companyGstStatusOn(
          tx,
          actor.companyId,
          toDay(before.purchasedOn),
        );
        const cost = expenseCost(
          {
            taxCode: before.taxCode,
            rateBasisPoints: BigInt(before.gstRateBasisPoints),
            exclusive: before.exclusiveCents,
            gst: before.gstCents,
            inclusive: before.inclusiveCents,
          },
          {
            companyRegistered: company.registered,
            document,
            evidenceVerified,
            creditableBasisPoints: BigInt(before.creditableBasisPoints),
          },
        );
        const hasEvidence = hasPurchaseEvidence({
          inclusive: before.inclusiveCents,
          document,
          verified: evidenceVerified,
        });
        const updated = await tx.expense.update({
          where: { id: before.id },
          data: {
            status: "approved",
            ...decided,
            companyGstRegistered: company.registered,
            evidenceVerified,
            hasEvidence,
            creditableGstCents: cost.creditableGst,
            nonCreditableGstCents: cost.nonCreditableGst,
            jobCostCents: cost.jobCost,
          },
          include: OFFICE_INCLUDE,
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "expense.approved",
          target: { type: "expense", id: before.id },
          before: { status: before.status },
          after: {
            status: updated.status,
            evidenceDocument: document,
            evidenceVerified,
            hasEvidence,
            creditableGstCents: cost.creditableGst,
            jobCostCents: cost.jobCost,
          },
        });
        return updated;
      });
      return privateJson(officeView(row));
    });
  };

  /**
   * Cancel an approved expense with an approved reversal carrying the
   * original's exact negated cents (one per expense). The original stays as
   * it was; a corrected expense can then be submitted.
   */
  const reverse: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Reverse.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const owned = await ownExpense(db(), actor, (await context.params).id);
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const original = await lockedExpense(tx, owned.id);
          if (original.status !== "approved" || original.reversesId)
            throw new Refusal(
              fail(409, "Only an approved expense can be reversed"),
            );
          if (original.reversedBy)
            throw new Refusal(fail(409, "This expense is already reversed"));
          const { settlement: effect, refundedOn, paymentMethod } = parsed.data;
          if (effect === "refund" && original.settlement !== "paid_at_purchase")
            throw new Refusal(
              fail(
                400,
                "Only an expense paid at purchase can be refunded",
                "settlement",
              ),
            );
          if (
            effect === "supplier_credit" &&
            original.settlement !== "on_account"
          )
            throw new Refusal(
              fail(
                400,
                "Only an expense on account gets a supplier credit",
                "settlement",
              ),
            );
          // A supplier credit cancels what's owed; money already paid on
          // account can't be credited away (#141). The expense row lock is
          // the one supplier payments take, so the two can't race.
          // A cost-only reversal changes the GST payments attribute: refused
          // too while payments are allocated (void them, reverse, re-pay).
          // Reversing a correction changes its on-account original's GST
          // too: lock that original (correction, then original, as decide
          // does) and check its payments.
          if (original.correctsId)
            await lockRow(tx, "expenses", original.correctsId);
          const root = original.correctsId
            ? await tx.expense.findUnique({
                where: { id: original.correctsId },
                select: { id: true, settlement: true },
              })
            : original;
          if (
            root?.settlement === "on_account" &&
            (await livePayments(tx, actor.companyId, root.id))
          )
            throw new Refusal(
              fail(
                409,
                "Supplier payments are allocated to this expense; void them first",
                "settlement",
              ),
            );
          if (effect === "refund" && !refundedOn)
            throw new Refusal(fail(400, "Enter the refund date", "refundedOn"));
          if (refundedOn && refundedOn > sydneyToday())
            throw new Refusal(
              fail(400, "The refund date can't be in the future", "refundedOn"),
            );
          const negated = reverseExpense({
            exclusive: original.exclusiveCents,
            gst: original.gstCents,
            inclusive: original.inclusiveCents,
            creditableGst: original.creditableGstCents ?? 0n,
            nonCreditableGst: original.nonCreditableGstCents ?? 0n,
            jobCost: original.jobCostCents ?? 0n,
          });
          const now = new Date();
          const created = await tx.expense.create({
            data: {
              companyId: actor.companyId,
              jobId: original.jobId,
              category: original.category,
              description: `Reversal: ${original.description}`.slice(0, 500),
              supplierName: original.supplierName,
              purchasedOn: original.purchasedOn,
              priceEntry: original.priceEntry,
              enteredAmountCents: -original.enteredAmountCents,
              taxCode: original.taxCode,
              gstRateBasisPoints: original.gstRateBasisPoints,
              exclusiveCents: negated.exclusive,
              gstCents: negated.gst,
              inclusiveCents: negated.inclusive,
              creditableBasisPoints: original.creditableBasisPoints,
              // Cost-only unless a refund or supplier credit is recorded.
              settlement:
                effect === "refund"
                  ? "paid_at_purchase"
                  : effect === "supplier_credit"
                    ? "on_account"
                    : null,
              paidOn:
                effect === "refund" && refundedOn ? fromDay(refundedOn) : null,
              paymentMethod:
                effect === "refund"
                  ? (paymentMethod ?? original.paymentMethod)
                  : null,
              status: "approved",
              decisionNote: parsed.data.note,
              decidedAt: now,
              decidedBy: actor.userId,
              companyGstRegistered: original.companyGstRegistered,
              evidenceVerified: original.evidenceVerified,
              hasEvidence: original.hasEvidence,
              creditableGstCents: negated.creditableGst,
              nonCreditableGstCents: negated.nonCreditableGst,
              jobCostCents: negated.jobCost,
              reversesId: original.id,
              submittedBy: actor.userId,
            },
            include: OFFICE_INCLUDE,
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "expense.reversed",
            target: { type: "expense", id: original.id },
            after: {
              reversalId: created.id,
              jobCostCents: negated.jobCost,
              settlementEffect: effect,
            },
          });
          return created;
        });
        return privateJson(officeView(row), { status: 201 });
      });
    } catch (error) {
      if (isUniqueViolation(error, "reverses_id"))
        return fail(409, "This expense is already reversed");
      throw error;
    }
  };

  return { list, read, mine, create, update, decide, reverse };
}
