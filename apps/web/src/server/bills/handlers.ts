import {
  supplierPaymentDateProblem,
  expensePaymentDateProblem,
  chronologyMessage,
  latestBillAdjustmentDay,
} from "../payments/chronology";
import { createHash, randomUUID } from "node:crypto";
import {
  type Actor,
  companyScope,
  notFound,
  requireSameCompany,
} from "@jobflow/authz";
import {
  type BillBalance,
  type CreditableBill,
  type EvidenceDocument,
  TAX_CODES,
  billCost,
  billLine,
  billLineProblem,
  billOutstanding,
  adjustmentDate,
  cashCorrectionProblem,
  creditAmounts,
  creditCashAdjustment,
  creditProblem,
  outstandingCommitment,
  paymentCreditableGst,
  paymentVoidAdjustment,
  paymentProblems,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
  SupplierBill,
  SupplierBillItem,
  SupplierCredit,
  SupplierCreditGstAdjustment,
  SupplierCreditItem,
  SupplierPayment,
  SupplierPaymentAllocation,
  SupplierPaymentExpenseAllocation,
  Expense,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { companyGstStatusOn, sydneyToday, toDay } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
import { lockDocumentClaim } from "../documents/claim";
import {
  abnField,
  optionalText,
  requiredText,
  uuidOrNull,
} from "../http/fields";
import { parsePage } from "../http/guards";
import { Refusal, inTransaction } from "../jobs/handlers";

// #46. Supplier and contractor bills (bill.read office; bill.write owner and
// accountant) and supplier payments (payment.read / payment.write). A bill's
// job cost is incurred once, when it is recorded; payments only settle the
// GST-inclusive balance. Money leaves the API as cent strings.

type IdContext = { params: Promise<{ id: string }> };
type BillRow = SupplierBill & {
  items: SupplierBillItem[];
  allocations: (SupplierPaymentAllocation & {
    payment: Pick<SupplierPayment, "voidedAt" | "paidOn">;
  })[];
  credits: SupplierCredit[];
  document: { kind: string } | null;
};
type PaymentRow = SupplierPayment & {
  allocations: SupplierPaymentAllocation[];
  expenseAllocations: SupplierPaymentExpenseAllocation[];
};

const PAYMENT_INCLUDE = {
  allocations: true,
  expenseAllocations: true,
} as const satisfies Prisma.SupplierPaymentInclude;

const day = z.iso.date("Use a date like 2026-07-01");
const cents = z
  .union([z.string().regex(/^\d{1,13}$/, "Whole cents only"), z.number().int()])
  .transform((value) => BigInt(value));

const Line = z.object({
  description: requiredText(500, "Describe the line"),
  taxCode: z.enum(TAX_CODES as [string, ...string[]], {
    error: "Choose a tax code",
  }),
  exclusiveCents: cents,
  gstCents: cents,
});

const CreateBill = z.object({
  /** A contractor's bill takes the contractor's name, ABN and GST status. */
  contractorId: z.uuid().nullable().optional(),
  /** The accepted offer this bill fulfils (contractor bills only). */
  offerId: z.uuid().nullable().optional(),
  jobId: z.uuid().nullable().optional(),
  supplierName: optionalText(200).optional(),
  supplierAbn: abnField.optional(),
  supplierGstRegistered: z.boolean().optional(),
  supplierReference: optionalText(100).optional(),
  issuedOn: day,
  dueOn: day.nullable().optional(),
  lines: z
    .array(Line)
    .min(1, "Add at least one line")
    .max(100, "At most 100 lines"),
  documentId: z.uuid().nullable().optional(),
  /** The recorder checked the attached document is a valid tax invoice. */
  evidenceVerified: z.boolean().default(false),
  creditableBasisPoints: z
    .number()
    .int()
    .min(0, "Between 0% and 100%")
    .max(10_000, "Between 0% and 100%")
    .default(10_000),
  creditableReason: optionalText(500).optional(),
  note: optionalText(500).optional(),
});

const CreatePayment = z.object({
  paidOn: day,
  amountCents: cents,
  method: z.enum(["bank_transfer", "card", "cash", "cheque", "other"]),
  reference: optionalText(100).optional(),
  /** Each line settles a bill or an approved on-account expense (#141). */
  allocations: z
    .array(
      z
        .object({
          billId: z.uuid().optional(),
          expenseId: z.uuid().optional(),
          amountCents: cents,
        })
        .refine(
          (line) => Boolean(line.billId) !== Boolean(line.expenseId),
          "Allocate each line to a bill or an expense",
        ),
    )
    .max(100),
});
const Void = z.object({ reason: requiredText(500, "Say why it's void") });

/** Client-chosen, opaque; the same key replays the same payment. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
const MAX_TOTAL = 1_000_000_000_000n;

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    { status },
  );
const refuse = (status: 400 | 409, error: string, field?: string) =>
  new Refusal(fail(status, error, field));

const BILL_INCLUDE = {
  items: { orderBy: { position: "asc" } },
  credits: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
  document: { select: { kind: true } },
  allocations: {
    include: { payment: { select: { voidedAt: true, paidOn: true } } },
  },
} as const satisfies Prisma.SupplierBillInclude;

const livePaid = (row: BillRow) =>
  row.allocations
    .filter((allocation) => allocation.payment.voidedAt === null)
    .reduce((total, allocation) => total + allocation.amountCents, 0n);

/** Totals of the live (unvoided) credits against a bill. */
export function liveCredited(
  credits: readonly Pick<
    SupplierCredit,
    | "voidedAt"
    | "exclusiveCents"
    | "gstCents"
    | "inclusiveCents"
    | "creditableGstCents"
    | "jobCostCents"
  >[],
) {
  const live = credits.filter((credit) => credit.voidedAt === null);
  const total = (pick: (credit: (typeof live)[number]) => bigint) =>
    live.reduce((sum, credit) => sum + pick(credit), 0n);
  return {
    exclusive: total((credit) => credit.exclusiveCents),
    gst: total((credit) => credit.gstCents),
    inclusive: total((credit) => credit.inclusiveCents),
    creditableGst: total((credit) => credit.creditableGstCents),
    jobCost: total((credit) => credit.jobCostCents),
  };
}

export function creditSummary(credit: SupplierCredit) {
  return {
    id: credit.id,
    supplierReference: credit.supplierReference,
    issuedOn: toDay(credit.issuedOn),
    receivedOn: toDay(credit.receivedOn),
    exclusiveCents: credit.exclusiveCents.toString(),
    gstCents: credit.gstCents.toString(),
    inclusiveCents: credit.inclusiveCents.toString(),
    creditableGstCents: credit.creditableGstCents.toString(),
    jobCostCents: credit.jobCostCents.toString(),
    voidedAt: credit.voidedAt,
  };
}

function billView(row: BillRow) {
  const paid = livePaid(row);
  const credited = liveCredited(row.credits);
  const outstanding = row.voidedAt
    ? 0n
    : billOutstanding({
        inclusive: row.inclusiveCents - credited.inclusive,
        paid,
      });
  return {
    id: row.id,
    jobId: row.jobId,
    contractorId: row.contractorId,
    offerId: row.offerId,
    supplierName: row.supplierName,
    supplierAbn: row.supplierAbn,
    supplierGstRegistered: row.supplierGstRegistered,
    supplierReference: row.supplierReference,
    issuedOn: toDay(row.issuedOn),
    dueOn: row.dueOn ? toDay(row.dueOn) : null,
    documentId: row.documentId,
    /** What the evidence is (tax invoice or receipt), so the UI never overstates it. */
    documentKind: row.document?.kind ?? null,
    evidenceVerified: row.evidenceVerified,
    hasEvidence: row.hasEvidence,
    companyGstRegistered: row.companyGstRegistered,
    creditablePercent: (row.creditableBasisPoints / 100).toString(),
    creditableReason: row.creditableReason,
    exclusiveCents: row.exclusiveCents.toString(),
    gstCents: row.gstCents.toString(),
    inclusiveCents: row.inclusiveCents.toString(),
    creditableGstCents: row.creditableGstCents.toString(),
    nonCreditableGstCents: row.nonCreditableGstCents.toString(),
    jobCostCents: row.jobCostCents.toString(),
    paidCents: paid.toString(),
    /** Live supplier credits (adjustment notes) against this bill. */
    creditedCents: credited.inclusive.toString(),
    netJobCostCents: (row.jobCostCents - credited.jobCost).toString(),
    netCreditableGstCents: (
      row.creditableGstCents - credited.creditableGst
    ).toString(),
    outstandingCents: outstanding.toString(),
    status: row.voidedAt ? "void" : outstanding === 0n ? "paid" : "open",
    note: row.note,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    createdAt: row.createdAt,
    lines: row.items.map((item) => ({
      position: item.position,
      description: item.description,
      taxCode: item.taxCode,
      gstRateBasisPoints: item.gstRateBasisPoints,
      exclusiveCents: item.exclusiveCents.toString(),
      gstCents: item.gstCents.toString(),
      inclusiveCents: item.inclusiveCents.toString(),
    })),
    credits: row.credits.map(creditSummary),
    payments: row.allocations.map((allocation) => ({
      paymentId: allocation.paymentId,
      paidOn: toDay(allocation.payment.paidOn),
      amountCents: allocation.amountCents.toString(),
      void: allocation.payment.voidedAt !== null,
    })),
  };
}

function paymentView(row: PaymentRow) {
  return {
    id: row.id,
    contractorId: row.contractorId,
    payeeName: row.payeeName,
    paidOn: toDay(row.paidOn),
    amountCents: row.amountCents.toString(),
    method: row.method,
    reference: row.reference,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    createdAt: row.createdAt,
    allocations: row.allocations.map((allocation) => ({
      billId: allocation.billId,
      amountCents: allocation.amountCents.toString(),
      creditableGstAttributedCents:
        allocation.creditableGstAttributedCents.toString(),
    })),
    expenseAllocations: row.expenseAllocations.map((allocation) => ({
      expenseId: allocation.expenseId,
      amountCents: allocation.amountCents.toString(),
      creditableGstAttributedCents:
        allocation.creditableGstAttributedCents.toString(),
    })),
  };
}

/** One payee per payment: the same contractor, or the same named supplier/ABN. */
function payeeKey(
  bill: Pick<SupplierBill, "contractorId" | "supplierName" | "supplierAbn">,
) {
  return bill.contractorId
    ? `contractor:${bill.contractorId}`
    : `supplier:${bill.supplierName.trim().toLowerCase()}:${bill.supplierAbn ?? ""}`;
}

/** Live bills' balances for these ids in this company; callers lock first. */
export async function billBalances(
  db: Prisma.TransactionClient | PrismaClient,
  companyId: string,
  billIds: readonly string[],
): Promise<
  Map<
    string,
    BillBalance & { bill: SupplierBill & { credits: SupplierCredit[] } }
  >
> {
  const bills = await db.supplierBill.findMany({
    where: { companyId, id: { in: [...billIds] }, voidedAt: null },
    include: { credits: true },
  });
  const paid = await db.supplierPaymentAllocation.groupBy({
    by: ["billId"],
    where: {
      companyId,
      billId: { in: bills.map((bill) => bill.id) },
      payment: { voidedAt: null },
    },
    _sum: { amountCents: true, creditableGstAttributedCents: true },
  });
  const paidBy = new Map(
    paid.map((row) => [row.billId, row._sum.amountCents ?? 0n]),
  );
  const adjusted = await db.supplierPaymentGstAdjustment.groupBy({
    by: ["billId"],
    where: { companyId, billId: { in: bills.map((bill) => bill.id) } },
    _sum: { creditableGstCents: true },
  });
  const creditAdjusted = await db.supplierCreditGstAdjustment.groupBy({
    by: ["billId"],
    where: { companyId, billId: { in: bills.map((bill) => bill.id) } },
    _sum: { creditableGstCents: true },
  });
  // Live credit: unvoided allocations plus the adjustments that payment
  // voids and supplier credits (recorded or voided) wrote.
  const attributedBy = new Map(
    adjusted.map((row) => [row.billId, row._sum.creditableGstCents ?? 0n]),
  );
  for (const row of creditAdjusted)
    attributedBy.set(
      row.billId,
      (attributedBy.get(row.billId) ?? 0n) +
        (row._sum.creditableGstCents ?? 0n),
    );
  for (const row of paid)
    attributedBy.set(
      row.billId,
      (attributedBy.get(row.billId) ?? 0n) +
        (row._sum.creditableGstAttributedCents ?? 0n),
    );
  return new Map(
    bills.map((bill) => [
      bill.id,
      {
        billId: bill.id,
        // Net of live credits: what is payable and claimable now.
        inclusive: bill.inclusiveCents - liveCredited(bill.credits).inclusive,
        creditableGst:
          bill.creditableGstCents - liveCredited(bill.credits).creditableGst,
        paid: paidBy.get(bill.id) ?? 0n,
        attributed: attributedBy.get(bill.id) ?? 0n,
        bill,
      },
    ]),
  );
}

/**
 * Supplier balances of payable on-account expenses (#141): approved
 * originals settled "on account" whose supplier balance wasn't cancelled by
 * a supplier-credit reversal. Same shape as a bill's balance; callers lock.
 */
export async function expenseBalances(
  db: Prisma.TransactionClient | PrismaClient,
  companyId: string,
  expenseIds: readonly string[],
): Promise<Map<string, BillBalance & { expense: Expense }>> {
  const expenses = await db.expense.findMany({
    where: {
      companyId,
      id: { in: [...expenseIds] },
      status: "approved",
      settlement: "on_account",
      reversesId: null,
    },
    include: {
      reversedBy: { select: { settlement: true } },
      corrections: {
        where: { status: "approved" },
        select: { creditableGstCents: true },
      },
      supplierPaymentAllocations: {
        where: { payment: { voidedAt: null } },
        select: { amountCents: true, creditableGstAttributedCents: true },
      },
      supplierPaymentGstAdjustments: {
        select: { creditableGstCents: true },
      },
    },
  });
  return new Map(
    expenses
      // A supplier-credit reversal cancels what was owed.
      .filter((expense) => expense.reversedBy?.settlement !== "on_account")
      .map((expense) => {
        const paid = expense.supplierPaymentAllocations.reduce(
          (total, allocation) => total + allocation.amountCents,
          0n,
        );
        const attributed =
          expense.supplierPaymentAllocations.reduce(
            (total, allocation) =>
              total + allocation.creditableGstAttributedCents,
            0n,
          ) +
          expense.supplierPaymentGstAdjustments.reduce(
            (total, adjustment) => total + adjustment.creditableGstCents,
            0n,
          );

        return [
          expense.id,
          {
            billId: expense.id,
            inclusive: expense.inclusiveCents,
            // The live tax snapshot: after a cost-only reversal, the approved
            // correction's credit, or none. (Reversals and corrections are
            // refused while payments exist, so attributed never goes stale.)
            creditableGst:
              expense.reversedBy && expense.reversedBy.settlement === null
                ? (expense.corrections[0]?.creditableGstCents ?? 0n)
                : (expense.creditableGstCents ?? 0n),
            paid,
            attributed,
            // The extra included relations are harmless on the payee read.
            expense: expense as Expense,
          },
        ];
      }),
  );
}

/** Lock expense rows in a fixed order, after any bills (no deadlocks). */
async function lockExpenses(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
) {
  for (const id of [...new Set(ids)].sort()) await lockRow(tx, "expenses", id);
}

/** Lock bill rows in a fixed order (no deadlocks between payments). */
async function lockBills(tx: Prisma.TransactionClient, ids: readonly string[]) {
  for (const id of [...new Set(ids)].sort())
    await lockRow(tx, "supplier_bills", id);
}

/**
 * Incurred bill cost for a job (live bills' job cost snapshots) and what its
 * accepted offers still commit after linked bills — each counted once (#54).
 */
export async function jobBillCosts(
  db: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  jobId: string,
): Promise<{ incurred: bigint; committed: bigint }> {
  const [bills, acceptances] = await Promise.all([
    db.supplierBill.findMany({
      where: { companyId, jobId, voidedAt: null },
      select: {
        jobCostCents: true,
        offerId: true,
        exclusiveCents: true,
        credits: {
          select: {
            voidedAt: true,
            exclusiveCents: true,
            gstCents: true,
            inclusiveCents: true,
            creditableGstCents: true,
            jobCostCents: true,
          },
        },
      },
    }),
    db.contractorAcceptance.findMany({
      where: { companyId, jobId },
      select: {
        offerId: true,
        committedCostCents: true,
        exclusiveCents: true,
      },
    }),
  ]);
  const committed = acceptances.reduce(
    (total, acceptance) =>
      total +
      outstandingCommitment({
        committed: acceptance.committedCostCents,
        committedExclusive: acceptance.exclusiveCents,
        billedExclusive: bills
          .filter((bill) => bill.offerId === acceptance.offerId)
          .map((bill) => bill.exclusiveCents),
      }),
    0n,
  );
  return {
    // Supplier credits reduce what was incurred; commitments follow the
    // gross bill (the work was done, just for less).
    incurred: bills.reduce(
      (total, bill) =>
        total + bill.jobCostCents - liveCredited(bill.credits).jobCost,
      0n,
    ),
    committed,
  };
}

export function billHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const jobId = uuidOrNull(params.get("jobId") ?? "");
    const contractorId = uuidOrNull(params.get("contractorId") ?? "");
    const status = z
      .enum(["live", "owing", "void", "all"])
      .catch("live")
      .parse(params.get("status") ?? undefined);
    // "owing": live bills not yet fully paid by live payments, filtered in
    // the database so paging never hides an old unpaid bill.
    const owing =
      status === "owing"
        ? (
            await db().$queryRaw<{ id: string }[]>`
              SELECT b.id FROM supplier_bills b
              WHERE b.company_id = ${actor.companyId}::uuid
                AND b.voided_at IS NULL
                AND b.inclusive_cents > COALESCE((
                  SELECT SUM(a.amount_cents)
                  FROM supplier_payment_allocations a
                  JOIN supplier_payments p ON p.id = a.payment_id
                  WHERE a.company_id = b.company_id
                    AND a.bill_id = b.id AND p.voided_at IS NULL
                ), 0) + COALESCE((
                  -- Live supplier credits (#140) reduce what is owed.
                  SELECT SUM(c.inclusive_cents)
                  FROM supplier_credits c
                  WHERE c.company_id = b.company_id
                    AND c.bill_id = b.id AND c.voided_at IS NULL
                ), 0)`
          ).map((row) => row.id)
        : null;
    const filter: Prisma.SupplierBillWhereInput = {
      ...(jobId ? { jobId } : {}),
      ...(contractorId ? { contractorId } : {}),
      ...(owing ? { id: { in: owing } } : {}),
      ...(status === "all"
        ? {}
        : { voidedAt: status === "void" ? { not: null } : null }),
    };
    const where: Prisma.SupplierBillWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().supplierBill.findMany({
        where,
        include: BILL_INCLUDE,
        orderBy: [{ issuedOn: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().supplierBill.count({ where }),
    ]);
    const job = jobId ? await jobBillCosts(db(), actor.companyId, jobId) : null;
    return privateJson({
      page,
      pageSize: take,
      total,
      bills: rows.map(billView),
      ...(job
        ? {
            job: {
              incurredCostCents: job.incurred.toString(),
              committedCostCents: job.committed.toString(),
            },
          }
        : {}),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id
        ? await db().supplierBill.findUnique({
            where: { id },
            include: BILL_INCLUDE,
          })
        : null,
    );
    return privateJson(billView(row));
  };

  /** Record a bill; its cost, creditable GST and evidence are fixed now. */
  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateBill.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    if (data.issuedOn > sydneyToday())
      return fail(400, "The bill date can't be in the future", "issuedOn");
    if (data.dueOn && data.dueOn < data.issuedOn)
      return fail(400, "Due on or after the bill date", "dueOn");
    if (data.creditableBasisPoints < 10_000 && !data.creditableReason)
      return fail(
        400,
        "Say why only part of the GST is claimable",
        "creditableReason",
      );
    if (data.offerId && !data.contractorId)
      return fail(400, "Choose the contractor of this offer", "contractorId");
    if (data.evidenceVerified && !data.documentId)
      return fail(
        400,
        "Attach the tax invoice before marking it verified",
        "documentId",
      );
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          let supplier: {
            name: string;
            abn: string | null;
            registered: boolean;
          };
          let jobId = data.jobId ?? null;
          // Lock order: contractor, then job, then document — the order
          // contractor writes (contractor → offer → job) and expenses (job →
          // document) take. Inserting the bill only key-shares rows already
          // locked here, so a racing expense or offer write can't deadlock it.
          if (data.contractorId) {
            await lockRow(tx, "contractors", data.contractorId);
            const contractor = await tx.contractor.findFirst({
              where: { id: data.contractorId, companyId: actor.companyId },
            });
            if (!contractor)
              throw refuse(400, "Choose a contractor", "contractorId");
            supplier = {
              name: contractor.name,
              abn: contractor.abn,
              registered: contractor.gstRegistered,
            };
            if (data.offerId) {
              const acceptance = await tx.contractorAcceptance.findFirst({
                where: {
                  companyId: actor.companyId,
                  offerId: data.offerId,
                  contractorId: contractor.id,
                },
              });
              if (!acceptance)
                throw refuse(
                  400,
                  "Choose an accepted offer of this contractor",
                  "offerId",
                );
              if (jobId && jobId !== acceptance.jobId)
                throw refuse(400, "That offer is for another job", "jobId");
              jobId = acceptance.jobId;
            }
          } else {
            if (!data.supplierName)
              throw refuse(400, "Enter the supplier's name", "supplierName");
            if (data.supplierGstRegistered === undefined)
              throw refuse(
                400,
                "Say whether the supplier is registered for GST",
                "supplierGstRegistered",
              );
            supplier = {
              name: data.supplierName,
              abn: data.supplierAbn ?? null,
              registered: data.supplierGstRegistered,
            };
          }
          if (supplier.registered && !supplier.abn)
            throw refuse(
              400,
              "Enter the ABN of a GST-registered supplier",
              "supplierAbn",
            );
          if (jobId) {
            await lockRow(tx, "jobs", jobId);
            const job = await tx.job.findFirst({
              where: { id: jobId, companyId: actor.companyId },
              select: { id: true },
            });
            if (!job) throw refuse(400, "Choose a job", "jobId");
          }
          const lines = data.lines.map((line, index) => {
            const input = {
              taxCode: line.taxCode as (typeof TAX_CODES)[number],
              exclusive: line.exclusiveCents,
              gst: line.gstCents,
            };
            const problem = billLineProblem(input, supplier.registered);
            if (problem) throw refuse(400, problem, `lines.${index}`);
            return { ...billLine(input), description: line.description };
          });
          let document: EvidenceDocument = null;
          if (data.documentId) {
            const found = await lockDocumentClaim(
              tx,
              actor.companyId,
              data.documentId,
            );
            if (!found || !["tax_invoice", "receipt"].includes(found.kind))
              throw refuse(
                400,
                "Attach an uploaded tax invoice or receipt",
                "documentId",
              );
            if (
              found.expense ||
              found.workEvidence ||
              found.supplierBill ||
              found.supplierCredit
            )
              throw refuse(
                400,
                "That document is already attached to another record",
                "documentId",
              );
            document = found.kind as "tax_invoice" | "receipt";
          }
          if (data.supplierReference) {
            const duplicate = await tx.supplierBill.findFirst({
              where: {
                companyId: actor.companyId,
                voidedAt: null,
                supplierReference: {
                  equals: data.supplierReference,
                  mode: "insensitive",
                },
                ...(data.contractorId
                  ? { contractorId: data.contractorId }
                  : {
                      contractorId: null,
                      supplierName: {
                        equals: supplier.name,
                        mode: "insensitive",
                      },
                    }),
              },
              select: { id: true },
            });
            if (duplicate)
              throw refuse(
                409,
                "This supplier invoice is already recorded",
                "supplierReference",
              );
          }
          const company = await companyGstStatusOn(
            tx,
            actor.companyId,
            data.issuedOn,
          );
          const cost = billCost(lines, {
            companyRegistered: company.registered,
            document,
            evidenceVerified: data.evidenceVerified,
            creditableBasisPoints: BigInt(data.creditableBasisPoints),
          });
          if (cost.inclusive <= 0n)
            throw refuse(400, "A bill must be for more than $0", "lines");
          if (cost.inclusive > MAX_TOTAL)
            throw refuse(400, "That bill is too large", "lines");
          const created = await tx.supplierBill.create({
            data: {
              companyId: actor.companyId,
              jobId,
              contractorId: data.contractorId ?? null,
              offerId: data.offerId ?? null,
              supplierName: supplier.name,
              supplierAbn: supplier.abn,
              supplierGstRegistered: supplier.registered,
              supplierReference: data.supplierReference ?? null,
              issuedOn: new Date(`${data.issuedOn}T00:00:00Z`),
              dueOn: data.dueOn ? new Date(`${data.dueOn}T00:00:00Z`) : null,
              documentId: data.documentId ?? null,
              evidenceVerified: data.evidenceVerified,
              hasEvidence: cost.hasEvidence,
              creditableBasisPoints: data.creditableBasisPoints,
              creditableReason: data.creditableReason ?? null,
              companyGstRegistered: company.registered,
              exclusiveCents: cost.exclusive,
              gstCents: cost.gst,
              inclusiveCents: cost.inclusive,
              creditableGstCents: cost.creditableGst,
              nonCreditableGstCents: cost.nonCreditableGst,
              jobCostCents: cost.jobCost,
              note: data.note ?? null,
              createdBy: actor.userId,
            },
          });
          await tx.supplierBillItem.createMany({
            data: lines.map((line, index) => ({
              companyId: actor.companyId,
              billId: created.id,
              position: index + 1,
              description: line.description,
              taxCode: line.taxCode,
              gstRateBasisPoints: Number(line.rateBasisPoints),
              exclusiveCents: line.exclusive,
              gstCents: line.gst,
              inclusiveCents: line.inclusive,
            })),
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "bill.recorded",
            target: { type: "supplier_bill", id: created.id },
            after: {
              supplierName: supplier.name,
              jobId,
              offerId: data.offerId ?? null,
              inclusiveCents: cost.inclusive,
              creditableGstCents: cost.creditableGst,
              jobCostCents: cost.jobCost,
            },
          });
          return tx.supplierBill.findUniqueOrThrow({
            where: { id: created.id },
            include: BILL_INCLUDE,
          });
        });
        return privateJson(billView(row), { status: 201 });
      });
    } catch (error) {
      // A concurrent copy of this supplier invoice committed first.
      if (isUniqueViolation(error, "_reference_key"))
        return fail(
          409,
          "This supplier invoice is already recorded",
          "supplierReference",
        );
      throw error;
    }
  };

  /** Void a bill (audited, final); its cost stops counting. Unpaid only. */
  const voidIt: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Void.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    if (!id) throw notFound();
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        await lockRow(tx, "supplier_bills", id);
        const before = requireSameCompany(
          actor,
          await tx.supplierBill.findUnique({
            where: { id },
            include: BILL_INCLUDE,
          }),
        );
        if (before.voidedAt) throw refuse(409, "It's already void");
        if (livePaid(before) > 0n)
          throw refuse(
            409,
            "Payments are allocated to this bill; void them first",
          );
        if (before.credits.some((credit) => credit.voidedAt === null))
          throw refuse(
            409,
            "Supplier credits are recorded against this bill; void them first",
          );
        await tx.supplierBill.update({
          where: { id },
          data: {
            voidReason: parsed.data.reason,
            voidedAt: new Date(),
            voidedBy: actor.userId,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "bill.voided",
          target: { type: "supplier_bill", id },
          before: { jobCostCents: before.jobCostCents },
          after: { reason: parsed.data.reason },
        });
        return tx.supplierBill.findUniqueOrThrow({
          where: { id },
          include: BILL_INCLUDE,
        });
      });
      return privateJson(billView(row));
    });
  };

  return { list, read, create, void: voidIt };
}

/** Stable fingerprint of what was asked for (keys sorted, cents as strings). */
function fingerprint(data: z.infer<typeof CreatePayment>): string {
  const canonical = {
    paidOn: data.paidOn,
    amountCents: data.amountCents.toString(),
    method: data.method,
    reference: data.reference ?? null,
    allocations: [...data.allocations]
      .map((a) => [
        a.billId ?? `expense:${a.expenseId}`,
        a.amountCents.toString(),
      ])
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function replay(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  key: string,
  hash: string,
): Promise<Response | null> {
  const existing = await db.supplierPayment.findUnique({
    where: {
      companyId_idempotencyKey: {
        companyId: actor.companyId,
        idempotencyKey: key,
      },
    },
    include: PAYMENT_INCLUDE,
  });
  if (!existing) return null;
  if (existing.requestHash !== hash)
    return fail(
      409,
      "That Idempotency-Key was already used for a different payment",
    );
  const response = privateJson(paymentView(existing), { status: 200 });
  response.headers.set("idempotent-replayed", "true");
  return response;
}

export function supplierPaymentHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const contractorId = uuidOrNull(params.get("contractorId") ?? "");
    const where: Prisma.SupplierPaymentWhereInput = companyScope(
      actor,
      contractorId ? { contractorId } : {},
    );
    const [rows, total] = await Promise.all([
      db().supplierPayment.findMany({
        where,
        include: PAYMENT_INCLUDE,
        orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().supplierPayment.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      payments: rows.map(paymentView),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id
        ? await db().supplierPayment.findUnique({
            where: { id },
            include: PAYMENT_INCLUDE,
          })
        : null,
    );
    return privateJson(paymentView(row));
  };

  /**
   * Record a payment and its allocations in one transaction. Requires an
   * Idempotency-Key header: retrying the same request — even concurrently —
   * returns the one payment; reusing the key for a different one is refused.
   */
  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const key = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(key))
      return fail(
        400,
        "Send an Idempotency-Key header (8–200 letters, digits or -_.:)",
      );
    const parsed = CreatePayment.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    if (data.paidOn > sydneyToday())
      return fail(400, "The date can't be in the future", "paidOn");
    const hash = fingerprint(data);
    const earlier = await replay(db(), actor, key, hash);
    if (earlier) return earlier;
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const billLines = data.allocations.filter((a) => a.billId);
          const expenseLines = data.allocations.filter((a) => a.expenseId);
          if (billLines.length > 0 && expenseLines.length > 0)
            throw refuse(
              400,
              "Pay bills and on-account expenses in separate payments",
              "allocations",
            );
          const forExpenses = expenseLines.length > 0;
          const ids = data.allocations.map((a) => (a.billId ?? a.expenseId)!);
          // Bills, then expenses — each in id order (the order every payment,
          // payment void and expense reversal takes).
          if (forExpenses) await lockExpenses(tx, ids);
          else await lockBills(tx, ids);
          // A concurrent duplicate may have committed while we waited for the
          // locks: replay it rather than judging it as an overpayment.
          const duplicate = await replay(tx, actor, key, hash);
          if (duplicate) throw new Refusal(duplicate);
          const balances: Map<string, BillBalance> = forExpenses
            ? await expenseBalances(tx, actor.companyId, ids)
            : await billBalances(tx, actor.companyId, ids);
          const allocations = data.allocations.map((a) => ({
            billId: (a.billId ?? a.expenseId)!,
            amount: a.amountCents,
          }));
          const problems = paymentProblems(
            data.amountCents,
            allocations,
            balances,
            forExpenses ? "expense" : "bill",
          );
          if (problems.length > 0)
            throw new Refusal(
              privateJson(
                {
                  error: problems[0]!.message,
                  fields: Object.fromEntries(
                    problems.map((p) => [p.field, p.message]),
                  ),
                },
                { status: 400 },
              ),
            );
          let payee: { contractorId: string | null; name: string };
          if (forExpenses) {
            const expenses = allocations.map(
              (a) =>
                (balances.get(a.billId) as BillBalance & { expense: Expense })
                  .expense,
            );
            const names = new Set(
              expenses.map((expense) =>
                (expense.supplierName ?? "").trim().toLowerCase(),
              ),
            );
            if (names.size > 1)
              throw refuse(
                400,
                "Pay one supplier at a time: these expenses are from different suppliers",
                "allocations",
              );
            // Unnamed suppliers can't be shown to be the same supplier.
            if (expenses.length > 1 && names.has(""))
              throw refuse(
                400,
                "Pay expenses without a supplier name one at a time",
                "allocations",
              );
            for (const expense of expenses) {
              // Never before the purchase: the non-cash credit is attributed
              // on the purchase date, so a prepayment would change it.
              if (data.paidOn < toDay(expense.purchasedOn))
                throw refuse(
                  400,
                  "Choose a payment date on or after the purchase date",
                  "paidOn",
                );
              // Cash basis: not before a correction already recorded (as bills).
              const latest =
                await tx.supplierPaymentExpenseGstAdjustment.aggregate({
                  where: { companyId: actor.companyId, expenseId: expense.id },
                  _max: { adjustedOn: true },
                });
              if (
                latest._max.adjustedOn &&
                data.paidOn < toDay(latest._max.adjustedOn)
              )
                throw refuse(
                  400,
                  "Choose a date on or after the expense's latest GST adjustment date",
                  "paidOn",
                );
            }
            payee = {
              contractorId: null,
              name: expenses[0]!.supplierName?.trim() || "Unnamed supplier",
            };
          } else {
            const bills = allocations.map(
              (a) =>
                (balances.get(a.billId) as BillBalance & { bill: SupplierBill })
                  .bill,
            );
            if (new Set(bills.map(payeeKey)).size > 1)
              throw refuse(
                400,
                "Pay one supplier at a time: these bills are from different suppliers",
                "allocations",
              );
            payee = {
              contractorId: bills[0]!.contractorId,
              name: bills[0]!.supplierName,
            };
            // Cash basis: attribution uses the bill's current credits, so a
            // payment can't be dated before them (as receipts, #54).
            for (const bill of bills) {
              if (
                (
                  await companyGstStatusOn(
                    tx,
                    actor.companyId,
                    toDay(bill.issuedOn),
                  )
                ).basis !== "cash"
              )
                continue;
              const latest = await latestBillAdjustmentDay(
                tx,
                actor.companyId,
                bill.id,
              );
              if (latest && data.paidOn < latest)
                throw refuse(
                  400,
                  "Choose a date on or after the bill's latest supplier credit or adjustment date",
                  "paidOn",
                );
            }
          }
          const paymentId = randomUUID(),
            createdAt = new Date();
          const dateProblem = forExpenses
            ? expensePaymentDateProblem
            : supplierPaymentDateProblem;
          for (const allocation of allocations) {
            if (
              await dateProblem(
                tx,
                actor.companyId,
                allocation.billId,
                balances.get(allocation.billId)!.inclusive,
                {
                  id: `${paymentId}:record`,
                  date: data.paidOn,
                  recordedAt: createdAt.toISOString(),
                  amount: allocation.amount,
                },
              )
            )
              throw refuse(400, chronologyMessage, "paidOn");
          }
          const created = await tx.supplierPayment.create({
            data: {
              id: paymentId,
              createdAt,
              companyId: actor.companyId,
              contractorId: payee.contractorId,
              payeeName: payee.name,
              paidOn: new Date(`${data.paidOn}T00:00:00Z`),
              amountCents: data.amountCents,
              method: data.method,
              reference: data.reference ?? null,
              idempotencyKey: key,
              requestHash: hash,
              createdBy: actor.userId,
            },
          });
          const lines = allocations.map((allocation) => ({
            companyId: actor.companyId,
            paymentId: created.id,
            amountCents: allocation.amount,
            creditableGstAttributedCents: paymentCreditableGst(
              allocation.amount,
              balances.get(allocation.billId)!,
            ),
            id: allocation.billId,
          }));
          if (forExpenses)
            await tx.supplierPaymentExpenseAllocation.createMany({
              data: lines.map(({ id, ...line }) => ({
                ...line,
                expenseId: id,
              })),
            });
          else
            await tx.supplierPaymentAllocation.createMany({
              data: lines.map(({ id, ...line }) => ({ ...line, billId: id })),
            });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "supplier_payment.recorded",
            target: { type: "supplier_payment", id: created.id },
            after: {
              payeeName: payee.name,
              amountCents: data.amountCents,
              allocations: allocations.map((a) => ({
                [forExpenses ? "expenseId" : "billId"]: a.billId,
                amountCents: a.amount,
              })),
            },
          });
          return tx.supplierPayment.findUniqueOrThrow({
            where: { id: created.id },
            include: PAYMENT_INCLUDE,
          });
        });
        return privateJson(paymentView(row), { status: 201 });
      });
    } catch (error) {
      // A concurrent request with the same key committed first: replay it.
      if (isUniqueViolation(error, "idempotency_key")) {
        const earlierNow = await replay(db(), actor, key, hash);
        if (earlierNow) return earlierNow;
      }
      throw error;
    }
  };

  /** Void a payment (audited, final): its bills and expenses become owing again. */
  const voidIt: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Void.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    if (!id) throw notFound();
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        await lockRow(tx, "supplier_payments", id);
        const before = requireSameCompany(
          actor,
          await tx.supplierPayment.findUnique({
            where: { id },
            include: PAYMENT_INCLUDE,
          }),
        );
        if (before.voidedAt) throw refuse(409, "It's already void");
        // Under the bill locks, keep each bill's live credit at the rounded
        // share of what stays paid: record the correction, never edit history.
        const ids = before.allocations.map((allocation) => allocation.billId);
        await lockBills(tx, ids);
        const balances = await billBalances(tx, actor.companyId, ids);
        const voidedAt = new Date(),
          voidDay = sydneyToday(voidedAt);
        for (const allocation of before.allocations) {
          if (
            await supplierPaymentDateProblem(
              tx,
              actor.companyId,
              allocation.billId,
              balances.get(allocation.billId)!.inclusive,
              {
                id: `${before.id}:void`,
                date: voidDay,
                recordedAt: voidedAt.toISOString(),
                amount: -allocation.amountCents,
              },
            )
          )
            throw refuse(400, chronologyMessage);
        }
        const today = new Date(`${voidDay}T00:00:00Z`);
        const gstAdjustments = before.allocations
          .map((allocation) => ({
            billId: allocation.billId,
            creditableGstCents: paymentVoidAdjustment(
              {
                amount: allocation.amountCents,
                gst: allocation.creditableGstAttributedCents,
              },
              balances.get(allocation.billId)!,
            ),
          }))
          .filter((adjustment) => adjustment.creditableGstCents !== 0n);
        if (gstAdjustments.length > 0)
          await tx.supplierPaymentGstAdjustment.createMany({
            data: gstAdjustments.map((adjustment) => ({
              companyId: actor.companyId,
              paymentId: id,
              billId: adjustment.billId,
              creditableGstCents: adjustment.creditableGstCents,
              adjustedOn: today,
            })),
          });
        // The same for on-account expenses (#141). A paid expense can't be
        // reversed with a supplier credit, so it is still payable here.
        const expenseIds = before.expenseAllocations.map(
          (allocation) => allocation.expenseId,
        );
        await lockExpenses(tx, expenseIds);
        const owed = await expenseBalances(tx, actor.companyId, expenseIds);
        for (const allocation of before.expenseAllocations) {
          const balance = owed.get(allocation.expenseId);
          if (
            balance &&
            (await expensePaymentDateProblem(
              tx,
              actor.companyId,
              allocation.expenseId,
              balance.inclusive,
              {
                id: `${before.id}:void`,
                date: voidDay,
                recordedAt: voidedAt.toISOString(),
                amount: -allocation.amountCents,
              },
            ))
          )
            throw refuse(400, chronologyMessage);
        }
        const expenseAdjustments = before.expenseAllocations
          .map((allocation) => {
            const balance = owed.get(allocation.expenseId);
            if (!balance)
              throw refuse(
                409,
                "An expense this payment settled is no longer payable",
              );
            return {
              expenseId: allocation.expenseId,
              creditableGstCents: paymentVoidAdjustment(
                {
                  amount: allocation.amountCents,
                  gst: allocation.creditableGstAttributedCents,
                },
                balance,
              ),
            };
          })
          .filter((adjustment) => adjustment.creditableGstCents !== 0n);
        if (expenseAdjustments.length > 0)
          await tx.supplierPaymentExpenseGstAdjustment.createMany({
            data: expenseAdjustments.map((adjustment) => ({
              companyId: actor.companyId,
              paymentId: id,
              expenseId: adjustment.expenseId,
              creditableGstCents: adjustment.creditableGstCents,
              adjustedOn: today,
            })),
          });
        const updated = await tx.supplierPayment.update({
          where: { id },
          data: {
            voidReason: parsed.data.reason,
            voidedAt,
            voidedBy: actor.userId,
          },
          include: PAYMENT_INCLUDE,
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "supplier_payment.voided",
          target: { type: "supplier_payment", id },
          after: {
            reason: parsed.data.reason,
            gstAdjustments: gstAdjustments.map((adjustment) => ({
              billId: adjustment.billId,
              creditableGstCents: adjustment.creditableGstCents.toString(),
            })),
            expenseGstAdjustments: expenseAdjustments.map((adjustment) => ({
              expenseId: adjustment.expenseId,
              creditableGstCents: adjustment.creditableGstCents.toString(),
            })),
          },
        });
        return updated;
      });
      return privateJson(paymentView(row));
    });
  };

  return { list, read, create, void: voidIt };
}

const CreateCredit = z.object({
  supplierReference: optionalText(100).optional(),
  issuedOn: day,
  /** When the note arrived (became known); defaults to today. */
  receivedOn: day.optional(),
  lines: z
    .array(Line)
    .min(1, "Add at least one line")
    .max(100, "At most 100 lines"),
  /** The supplier's adjustment note, if uploaded. */
  documentId: z.uuid().nullable().optional(),
  /** The recorder checked the attached document is a valid adjustment note. */
  evidenceVerified: z.boolean().default(false),
  note: optionalText(500).optional(),
});

type CreditRow = SupplierCredit & {
  items: SupplierCreditItem[];
  gstAdjustments: SupplierCreditGstAdjustment[];
};

const CREDIT_INCLUDE = {
  items: { orderBy: { position: "asc" } },
  gstAdjustments: { orderBy: { createdAt: "asc" } },
} as const satisfies Prisma.SupplierCreditInclude;

function creditView(row: CreditRow) {
  return {
    ...creditSummary(row),
    billId: row.billId,
    documentId: row.documentId,
    evidenceVerified: row.evidenceVerified,
    nonCreditableGstCents: row.nonCreditableGstCents.toString(),
    note: row.note,
    voidReason: row.voidReason,
    createdAt: row.createdAt,
    lines: row.items.map((item) => ({
      position: item.position,
      description: item.description,
      taxCode: item.taxCode,
      exclusiveCents: item.exclusiveCents.toString(),
      gstCents: item.gstCents.toString(),
      inclusiveCents: item.inclusiveCents.toString(),
    })),
    /** Cash-basis input tax credit corrections this credit wrote. */
    cashGstAdjustments: row.gstAdjustments.map((adjustment) => ({
      event: adjustment.event,
      creditableGstCents: adjustment.creditableGstCents.toString(),
      adjustedOn: toDay(adjustment.adjustedOn),
    })),
  };
}

/** The bill snapshot a credit is measured against (domain shape). */
function creditableBill(bill: SupplierBill): CreditableBill {
  return {
    exclusive: bill.exclusiveCents,
    gst: bill.gstCents,
    inclusive: bill.inclusiveCents,
    creditableGst: bill.creditableGstCents,
    companyRegistered: bill.companyGstRegistered,
    hasEvidence: bill.hasEvidence,
    creditableBasisPoints: BigInt(bill.creditableBasisPoints),
  };
}

/**
 * Supplier credit notes against bills (#140): record one (bill.write), read
 * it (bill.read), void it (bill.write). Each locks its bill first — the same
 * lock payments take — so credits and payments can never together take a
 * bill below zero.
 */
export function supplierCreditHandlers(db: () => PrismaClient) {
  const create: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = CreateCredit.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    const billId = uuidOrNull((await context.params).id);
    if (!billId) throw notFound();
    const today = sydneyToday();
    const receivedOn = data.receivedOn ?? today;
    if (data.issuedOn > today)
      return fail(400, "The credit date can't be in the future", "issuedOn");
    if (receivedOn > today || receivedOn < data.issuedOn)
      return fail(
        400,
        "Received on or after the credit date, and not in the future",
        "receivedOn",
      );
    if (data.evidenceVerified && !data.documentId)
      return fail(
        400,
        "Attach the adjustment note before marking it verified",
        "documentId",
      );
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          await lockRow(tx, "supplier_bills", billId);
          const bill = requireSameCompany(
            actor,
            await tx.supplierBill.findUnique({ where: { id: billId } }),
          );
          if (bill.voidedAt) throw refuse(409, "A void bill can't be credited");
          if (data.issuedOn < toDay(bill.issuedOn))
            throw refuse(
              400,
              "A credit can't be dated before its bill",
              "issuedOn",
            );
          const lines = data.lines.map((line, index) => {
            const input = {
              taxCode: line.taxCode as (typeof TAX_CODES)[number],
              exclusive: line.exclusiveCents,
              gst: line.gstCents,
            };
            const problem = billLineProblem(input, bill.supplierGstRegistered);
            if (problem) throw refuse(400, problem, `lines.${index}`);
            return { ...billLine(input), description: line.description };
          });
          if (data.documentId) {
            const found = await lockDocumentClaim(
              tx,
              actor.companyId,
              data.documentId,
            );
            if (
              !found ||
              !["tax_invoice", "receipt", "other"].includes(found.kind)
            )
              throw refuse(
                400,
                "Attach the supplier's uploaded adjustment note",
                "documentId",
              );
            if (
              found.expense ||
              found.workEvidence ||
              found.supplierBill ||
              found.supplierCredit
            )
              throw refuse(
                400,
                "That document is already attached to another record",
                "documentId",
              );
          }
          const balance = (
            await billBalances(tx, actor.companyId, [billId])
          ).get(billId)!;
          const credited = liveCredited(balance.bill.credits);
          const snapshot = creditableBill(bill);
          const problem = creditProblem(
            lines,
            snapshot,
            credited,
            balance.paid,
          );
          if (problem) throw refuse(400, problem, "lines");
          const amounts = creditAmounts(lines, snapshot, credited);
          const created = await tx.supplierCredit.create({
            data: {
              companyId: actor.companyId,
              billId,
              supplierReference: data.supplierReference ?? null,
              issuedOn: new Date(`${data.issuedOn}T00:00:00Z`),
              receivedOn: new Date(`${receivedOn}T00:00:00Z`),
              documentId: data.documentId ?? null,
              evidenceVerified: data.evidenceVerified,
              exclusiveCents: amounts.exclusive,
              gstCents: amounts.gst,
              inclusiveCents: amounts.inclusive,
              creditableGstCents: amounts.creditableGst,
              nonCreditableGstCents: amounts.nonCreditableGst,
              jobCostCents: amounts.jobCost,
              note: data.note ?? null,
              createdBy: actor.userId,
            },
          });
          await tx.supplierCreditItem.createMany({
            data: lines.map((line, index) => ({
              companyId: actor.companyId,
              creditId: created.id,
              position: index + 1,
              description: line.description,
              taxCode: line.taxCode,
              gstRateBasisPoints: Number(line.rateBasisPoints),
              exclusiveCents: line.exclusive,
              gstCents: line.gst,
              inclusiveCents: line.inclusive,
            })),
          });
          // Cash basis: re-base what payments attributed on the net bill.
          const adjustment = creditCashAdjustment({
            netInclusive: balance.inclusive - amounts.inclusive,
            netCreditableGst: balance.creditableGst - amounts.creditableGst,
            paid: balance.paid,
            attributed: balance.attributed,
          });
          const noteProblem = cashCorrectionProblem({
            adjustment,
            noteVerified: data.evidenceVerified,
          });
          if (noteProblem) throw refuse(400, noteProblem, "documentId");
          if (adjustment !== 0n) {
            // Dated no earlier than the note arrived or the GST posting of
            // the payments it re-splits (a late payment posts to the open
            // period), so it never lands in an earlier period.
            const [lastPaid] = await tx.$queryRaw<{ day: Date | null }[]>`
              SELECT max(COALESCE(g.effective_on, p.paid_on)) AS day
              FROM supplier_payment_allocations a
              JOIN supplier_payments p ON p.id = a.payment_id AND p.company_id = a.company_id
              LEFT JOIN gst_source_postings g
                ON g.company_id = p.company_id AND g.source_id = p.id AND g.original_on = p.paid_on
              WHERE a.company_id = ${actor.companyId}::uuid AND a.bill_id = ${billId}::uuid
                AND p.voided_at IS NULL`;
            // ...nor before a correction already recorded on this bill.
            const corrected = await latestBillAdjustmentDay(
              tx,
              actor.companyId,
              billId,
            );
            await tx.supplierCreditGstAdjustment.create({
              data: {
                companyId: actor.companyId,
                creditId: created.id,
                billId,
                event: "recorded",
                creditableGstCents: adjustment,
                adjustedOn: new Date(
                  `${adjustmentDate([
                    data.issuedOn,
                    receivedOn,
                    lastPaid?.day ? toDay(lastPaid.day) : null,
                    corrected,
                  ])}T00:00:00Z`,
                ),
              },
            });
          }
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "supplier_credit.recorded",
            target: { type: "supplier_credit", id: created.id },
            after: {
              billId,
              inclusiveCents: amounts.inclusive,
              creditableGstCents: amounts.creditableGst,
              jobCostCents: amounts.jobCost,
              cashGstAdjustmentCents: adjustment,
            },
          });
          return tx.supplierCredit.findUniqueOrThrow({
            where: { id: created.id },
            include: CREDIT_INCLUDE,
          });
        });
        return privateJson(creditView(row), { status: 201 });
      });
    } catch (error) {
      // A concurrent copy of this supplier note committed first.
      if (isUniqueViolation(error, "supplier_credits_live_reference_key"))
        return fail(
          409,
          "This supplier credit note is already recorded on the bill",
          "supplierReference",
        );
      throw error;
    }
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id
        ? await db().supplierCredit.findUnique({
            where: { id },
            include: CREDIT_INCLUDE,
          })
        : null,
    );
    return privateJson(creditView(row));
  };

  /** Void a credit (audited, final): the bill owes, costs and claims as before. */
  const voidIt: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Void.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    if (!id) throw notFound();
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const found = requireSameCompany(
          actor,
          await tx.supplierCredit.findUnique({ where: { id } }),
        );
        // Bill first, then the credit: the order recording a credit takes.
        await lockRow(tx, "supplier_bills", found.billId);
        await lockRow(tx, "supplier_credits", id);
        const before = await tx.supplierCredit.findUniqueOrThrow({
          where: { id },
        });
        if (before.voidedAt) throw refuse(409, "It's already void");
        const balance = (
          await billBalances(tx, actor.companyId, [before.billId])
        ).get(before.billId);
        // Bills with live credits can't be voided, so the bill is live.
        if (!balance) throw refuse(409, "Its bill is void");
        // One clock read: the void and its cash correction share a day.
        const voidedAt = new Date();
        await tx.supplierCredit.update({
          where: { id },
          data: {
            voidReason: parsed.data.reason,
            voidedAt,
            voidedBy: actor.userId,
          },
        });
        const adjustment = creditCashAdjustment({
          netInclusive: balance.inclusive + before.inclusiveCents,
          netCreditableGst: balance.creditableGst + before.creditableGstCents,
          paid: balance.paid,
          attributed: balance.attributed,
        });
        if (adjustment !== 0n)
          await tx.supplierCreditGstAdjustment.create({
            data: {
              companyId: actor.companyId,
              creditId: id,
              billId: before.billId,
              event: "voided",
              creditableGstCents: adjustment,
              adjustedOn: new Date(`${sydneyToday(voidedAt)}T00:00:00Z`),
            },
          });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "supplier_credit.voided",
          target: { type: "supplier_credit", id },
          before: {
            billId: before.billId,
            inclusiveCents: before.inclusiveCents,
            creditableGstCents: before.creditableGstCents,
            jobCostCents: before.jobCostCents,
          },
          after: {
            reason: parsed.data.reason,
            cashGstAdjustmentCents: adjustment,
          },
        });
        return tx.supplierCredit.findUniqueOrThrow({
          where: { id },
          include: CREDIT_INCLUDE,
        });
      });
      return privateJson(creditView(row));
    });
  };

  return { create, read, void: voidIt };
}
