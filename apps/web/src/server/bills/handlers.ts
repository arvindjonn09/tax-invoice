import { createHash } from "node:crypto";
import {
  type Actor,
  companyScope,
  notFound,
  requireSameCompany,
} from "@jobflow/authz";
import {
  type BillBalance,
  type EvidenceDocument,
  TAX_CODES,
  billCost,
  billLine,
  billLineProblem,
  billOutstanding,
  outstandingCommitment,
  paymentCreditableGst,
  paymentProblems,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Prisma,
  PrismaClient,
  SupplierBill,
  SupplierBillItem,
  SupplierPayment,
  SupplierPaymentAllocation,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { companyGstStatusOn, sydneyToday, toDay } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
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
};
type PaymentRow = SupplierPayment & {
  allocations: SupplierPaymentAllocation[];
};

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
  allocations: z
    .array(z.object({ billId: z.uuid(), amountCents: cents }))
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
  allocations: {
    include: { payment: { select: { voidedAt: true, paidOn: true } } },
  },
} as const satisfies Prisma.SupplierBillInclude;

const livePaid = (row: BillRow) =>
  row.allocations
    .filter((allocation) => allocation.payment.voidedAt === null)
    .reduce((total, allocation) => total + allocation.amountCents, 0n);

function billView(row: BillRow) {
  const paid = livePaid(row);
  const outstanding = row.voidedAt
    ? 0n
    : billOutstanding({
        billId: row.id,
        inclusive: row.inclusiveCents,
        creditableGst: row.creditableGstCents,
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
): Promise<Map<string, BillBalance & { bill: SupplierBill }>> {
  const bills = await db.supplierBill.findMany({
    where: { companyId, id: { in: [...billIds] }, voidedAt: null },
  });
  const paid = await db.supplierPaymentAllocation.groupBy({
    by: ["billId"],
    where: {
      companyId,
      billId: { in: bills.map((bill) => bill.id) },
      payment: { voidedAt: null },
    },
    _sum: { amountCents: true },
  });
  const paidBy = new Map(
    paid.map((row) => [row.billId, row._sum.amountCents ?? 0n]),
  );
  return new Map(
    bills.map((bill) => [
      bill.id,
      {
        billId: bill.id,
        inclusive: bill.inclusiveCents,
        creditableGst: bill.creditableGstCents,
        paid: paidBy.get(bill.id) ?? 0n,
        bill,
      },
    ]),
  );
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
      select: { jobCostCents: true, offerId: true, exclusiveCents: true },
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
    incurred: bills.reduce((total, bill) => total + bill.jobCostCents, 0n),
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
      .enum(["live", "void", "all"])
      .catch("live")
      .parse(params.get("status") ?? undefined);
    const filter: Prisma.SupplierBillWhereInput = {
      ...(jobId ? { jobId } : {}),
      ...(contractorId ? { contractorId } : {}),
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
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        let supplier: {
          name: string;
          abn: string | null;
          registered: boolean;
        };
        let jobId = data.jobId ?? null;
        if (data.contractorId) {
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
          const found = await tx.document.findFirst({
            where: { id: data.documentId, companyId: actor.companyId },
            include: {
              expense: { select: { id: true } },
              workEvidence: { select: { id: true } },
              supplierBill: { select: { id: true } },
            },
          });
          if (!found || !["tax_invoice", "receipt"].includes(found.kind))
            throw refuse(
              400,
              "Attach an uploaded tax invoice or receipt",
              "documentId",
            );
          if (found.expense || found.workEvidence || found.supplierBill)
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
              supplierReference: data.supplierReference,
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
      .map((a) => [a.billId, a.amountCents.toString()])
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
    include: { allocations: true },
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
        include: { allocations: true },
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
            include: { allocations: true },
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
          const ids = data.allocations.map((a) => a.billId);
          await lockBills(tx, ids);
          // A concurrent duplicate may have committed while we waited for the
          // bill locks: replay it rather than judging it as an overpayment.
          const duplicate = await replay(tx, actor, key, hash);
          if (duplicate) throw new Refusal(duplicate);
          const balances = await billBalances(tx, actor.companyId, ids);
          const allocations = data.allocations.map((a) => ({
            billId: a.billId,
            amount: a.amountCents,
          }));
          const problems = paymentProblems(
            data.amountCents,
            allocations,
            balances,
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
          const bills = allocations.map((a) => balances.get(a.billId)!.bill);
          if (new Set(bills.map(payeeKey)).size > 1)
            throw refuse(
              400,
              "Pay one supplier at a time: these bills are from different suppliers",
              "allocations",
            );
          const payee = bills[0]!;
          const created = await tx.supplierPayment.create({
            data: {
              companyId: actor.companyId,
              contractorId: payee.contractorId,
              payeeName: payee.supplierName,
              paidOn: new Date(`${data.paidOn}T00:00:00Z`),
              amountCents: data.amountCents,
              method: data.method,
              reference: data.reference ?? null,
              idempotencyKey: key,
              requestHash: hash,
              createdBy: actor.userId,
            },
          });
          await tx.supplierPaymentAllocation.createMany({
            data: allocations.map((allocation) => ({
              companyId: actor.companyId,
              paymentId: created.id,
              billId: allocation.billId,
              amountCents: allocation.amount,
              creditableGstAttributedCents: paymentCreditableGst(
                allocation.amount,
                balances.get(allocation.billId)!,
              ),
            })),
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action: "supplier_payment.recorded",
            target: { type: "supplier_payment", id: created.id },
            after: {
              payeeName: payee.supplierName,
              amountCents: data.amountCents,
              allocations: allocations.map((a) => ({
                billId: a.billId,
                amountCents: a.amount,
              })),
            },
          });
          return tx.supplierPayment.findUniqueOrThrow({
            where: { id: created.id },
            include: { allocations: true },
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

  /** Void a payment (audited, final): its bills become owing again. */
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
          await tx.supplierPayment.findUnique({ where: { id } }),
        );
        if (before.voidedAt) throw refuse(409, "It's already void");
        const updated = await tx.supplierPayment.update({
          where: { id },
          data: {
            voidReason: parsed.data.reason,
            voidedAt: new Date(),
            voidedBy: actor.userId,
          },
          include: { allocations: true },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "supplier_payment.voided",
          target: { type: "supplier_payment", id },
          after: { reason: parsed.data.reason },
        });
        return updated;
      });
      return privateJson(paymentView(row));
    });
  };

  return { list, read, create, void: voidIt };
}
