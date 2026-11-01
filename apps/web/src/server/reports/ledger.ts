import {
  type AgeingDocument,
  ageingReport,
  cashMovementReport,
} from "@jobflow/domain";
import type {
  Prisma,
  PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { z } from "zod";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid } from "../company/handlers";
import { toDay } from "../company/gst";
import { businessDay, financialEvents } from "./events";

// Debtor/creditor ageing and cash movement (#56), owner/accountant only.
// Ageing is as at the end of a day, as the records stood then: a later
// receipt, credit or void never changes an earlier ageing.

export type AgeingLabel = {
  reference: string;
  partyName: string;
  partyType: "customer" | "contractor" | "supplier";
};
export type AgeingSource = {
  documents: AgeingDocument[];
  labels: Map<string, AgeingLabel>;
  parties: Map<string, { name: string; type: AgeingLabel["partyType"] }>;
};

const day = (value: Date | null) => (value ? businessDay(value) : null);

/**
 * Issued invoices with something owed at the end of `asAt`. Without
 * `bounded: false`, the database first narrows to exactly those (the same
 * as-at rule in SQL), so fully settled history is never read; tests prove
 * the narrowed result equals reading every invoice.
 */
export async function receivablesSource(
  tx: Prisma.TransactionClient,
  companyId: string,
  asAt: string,
  { bounded = true }: { bounded?: boolean } = {},
): Promise<AgeingSource> {
  const ids = bounded
    ? (
        await tx.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM invoices i
      WHERE i.company_id = ${companyId}::uuid
        AND i.kind = 'invoice' AND i.status IN ('issued','void')
        AND i.issue_date <= ${asAt}::date
        AND (i.voided_at IS NULL
          OR (i.voided_at AT TIME ZONE 'Australia/Sydney')::date > ${asAt}::date)
        AND i.inclusive_cents > COALESCE((
          SELECT SUM(CASE WHEN r.kind = 'refund'
                     THEN -a.amount_cents ELSE a.amount_cents END)
          FROM receipt_allocations a
          JOIN customer_receipts r ON r.id = a.receipt_id
          WHERE a.company_id = i.company_id AND a.invoice_id = i.id
            AND r.received_on <= ${asAt}::date
            AND (r.voided_at IS NULL
              OR (r.voided_at AT TIME ZONE 'Australia/Sydney')::date > ${asAt}::date)
        ), 0) + COALESCE((
          SELECT SUM(c.inclusive_cents) FROM invoices c
          WHERE c.company_id = i.company_id AND c.credits_id = i.id
            AND c.kind = 'credit_note' AND c.status IN ('issued','void')
            AND c.issue_date <= ${asAt}::date
            AND (c.voided_at IS NULL
              OR (c.voided_at AT TIME ZONE 'Australia/Sydney')::date > ${asAt}::date)
        ), 0)`
      ).map((row) => row.id)
    : undefined;
  const rows = await tx.invoice.findMany({
    where: {
      companyId,
      kind: "invoice",
      status: { in: ["issued", "void"] },
      ...(ids ? { id: { in: ids } } : {}),
    },
    select: {
      id: true,
      reference: true,
      number: true,
      customerId: true,
      issueDate: true,
      dueOn: true,
      inclusiveCents: true,
      voidedAt: true,
      customer: { select: { name: true } },
      allocations: {
        select: {
          amountCents: true,
          receipt: { select: { kind: true, receivedOn: true, voidedAt: true } },
        },
      },
    },
  });
  const credits = await tx.invoice.findMany({
    where: {
      companyId,
      kind: "credit_note",
      status: { in: ["issued", "void"] },
      creditsId: { in: rows.map((row) => row.id) },
    },
    select: {
      creditsId: true,
      issueDate: true,
      inclusiveCents: true,
      voidedAt: true,
    },
  });
  const labels = new Map<string, AgeingLabel>();
  const parties: AgeingSource["parties"] = new Map();
  const documents = rows
    .filter((row) => row.issueDate)
    .map((row): AgeingDocument => {
      const reference = row.reference ?? String(row.number ?? row.id);
      labels.set(row.id, {
        reference,
        partyName: row.customer.name,
        partyType: "customer",
      });
      parties.set(row.customerId, {
        name: row.customer.name,
        type: "customer",
      });
      return {
        id: row.id,
        partyId: row.customerId,
        issuedOn: toDay(row.issueDate!),
        dueOn: row.dueOn ? toDay(row.dueOn) : null,
        inclusive: row.inclusiveCents,
        voidedOn: day(row.voidedAt),
        settlements: [
          ...row.allocations.map((a) => ({
            on: toDay(a.receipt.receivedOn),
            amount:
              a.receipt.kind === "refund" ? -a.amountCents : a.amountCents,
            voidedOn: day(a.receipt.voidedAt),
          })),
          ...credits
            .filter((c) => c.creditsId === row.id && c.issueDate)
            .map((c) => ({
              on: toDay(c.issueDate!),
              amount: c.inclusiveCents,
              voidedOn: day(c.voidedAt),
            })),
        ],
      };
    });
  return { documents, labels, parties };
}

/** Supplier bills with something owed at the end of `asAt` (see above). */
export async function payablesSource(
  tx: Prisma.TransactionClient,
  companyId: string,
  asAt: string,
  { bounded = true }: { bounded?: boolean } = {},
): Promise<AgeingSource> {
  const ids = bounded
    ? (
        await tx.$queryRaw<{ id: string }[]>`
      SELECT b.id FROM supplier_bills b
      WHERE b.company_id = ${companyId}::uuid
        AND b.issued_on <= ${asAt}::date
        AND (b.voided_at IS NULL
          OR (b.voided_at AT TIME ZONE 'Australia/Sydney')::date > ${asAt}::date)
        AND b.inclusive_cents > COALESCE((
          SELECT SUM(a.amount_cents)
          FROM supplier_payment_allocations a
          JOIN supplier_payments p ON p.id = a.payment_id
          WHERE a.company_id = b.company_id AND a.bill_id = b.id
            AND p.paid_on <= ${asAt}::date
            AND (p.voided_at IS NULL
              OR (p.voided_at AT TIME ZONE 'Australia/Sydney')::date > ${asAt}::date)
        ), 0) + COALESCE((
          SELECT SUM(c.inclusive_cents) FROM supplier_credits c
          WHERE c.company_id = b.company_id AND c.bill_id = b.id
            AND c.received_on <= ${asAt}::date
            AND (c.voided_at IS NULL
              OR (c.voided_at AT TIME ZONE 'Australia/Sydney')::date > ${asAt}::date)
        ), 0)`
      ).map((row) => row.id)
    : undefined;
  const rows = await tx.supplierBill.findMany({
    where: { companyId, ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      supplierName: true,
      supplierReference: true,
      contractorId: true,
      contractor: { select: { name: true } },
      issuedOn: true,
      dueOn: true,
      inclusiveCents: true,
      voidedAt: true,
      allocations: {
        select: {
          amountCents: true,
          payment: { select: { paidOn: true, voidedAt: true } },
        },
      },
      credits: {
        select: { receivedOn: true, inclusiveCents: true, voidedAt: true },
      },
    },
  });
  const labels = new Map<string, AgeingLabel>();
  const parties: AgeingSource["parties"] = new Map();
  const documents = rows.map((row): AgeingDocument => {
    // A bill from a contractor ages under them; otherwise under the
    // supplier name as entered.
    const partyType = row.contractorId ? "contractor" : "supplier";
    const partyName = row.contractor?.name ?? row.supplierName;
    const partyId = row.contractorId
      ? `contractor:${row.contractorId}`
      : `supplier:${row.supplierName.trim().toLowerCase()}`;
    labels.set(row.id, {
      reference: row.supplierReference ?? "",
      partyName,
      partyType,
    });
    parties.set(partyId, { name: partyName, type: partyType });
    return {
      id: row.id,
      partyId,
      issuedOn: toDay(row.issuedOn),
      dueOn: row.dueOn ? toDay(row.dueOn) : null,
      inclusive: row.inclusiveCents,
      voidedOn: day(row.voidedAt),
      settlements: [
        ...row.allocations.map((a) => ({
          on: toDay(a.payment.paidOn),
          amount: a.amountCents,
          voidedOn: day(a.payment.voidedAt),
        })),
        ...row.credits.map((c) => ({
          on: toDay(c.receivedOn),
          amount: c.inclusiveCents,
          voidedOn: day(c.voidedAt),
        })),
      ],
    };
  });
  return { documents, labels, parties };
}

export const AgeingQuery = z.object({
  side: z.enum(["receivables", "payables"]),
  asAt: z.iso.date(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
});
export const CashQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, {
    message: "End date must be on or after start date",
    path: ["to"],
  });

/** Ageing rows with their labels, for the screen and the export. */
export async function ageing(
  tx: Prisma.TransactionClient,
  companyId: string,
  side: "receivables" | "payables",
  asAt: string,
) {
  const source = await (side === "receivables"
    ? receivablesSource(tx, companyId, asAt)
    : payablesSource(tx, companyId, asAt));
  const report = ageingReport(source.documents, asAt);
  return {
    side,
    ...report,
    parties: report.parties.map((p) => ({
      ...p,
      partyName: p.partyId ? (source.parties.get(p.partyId)?.name ?? "") : "",
      partyType: p.partyId
        ? (source.parties.get(p.partyId)?.type ?? null)
        : null,
    })),
    rows: report.rows.map((row) => ({ ...row, ...source.labels.get(row.id)! })),
  };
}

/** Receipts less payments from the shared, bounded event source. */
export async function cashMovement(
  tx: Prisma.TransactionClient,
  companyId: string,
  range: { from: string; to: string },
) {
  const source = await financialEvents(tx, companyId, { since: range.from });
  return cashMovementReport(
    source.events.flatMap((e) =>
      e.channel === "received" || e.channel === "paid"
        ? [
            {
              id: e.id,
              date: e.date,
              direction: e.channel === "received" ? "in" : "out",
              amount: e.amount,
            } as const,
          ]
        : [],
    ),
    range,
  );
}

const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as unknown;
const params = (request: Request) =>
  Object.fromEntries(new URL(request.url).searchParams);

export function ledgerHandlers(db: () => PrismaClient) {
  const ageingRead: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = AgeingQuery.safeParse(params(request));
    if (!parsed.success) return invalid(parsed.error);
    const { side, asAt, page, pageSize } = parsed.data;
    const report = await db().$transaction(
      (tx) => ageing(tx, actor.companyId, side, asAt),
      { isolationLevel: "RepeatableRead" },
    );
    const start = (page - 1) * pageSize;
    return privateJson(
      json({
        ...report,
        rows: report.rows.slice(start, start + pageSize),
        rowsPage: { page, pageSize, total: report.rows.length },
      }),
    );
  };
  const cashRead: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CashQuery.safeParse(params(request));
    if (!parsed.success) return invalid(parsed.error);
    const report = await db().$transaction(
      (tx) => cashMovement(tx, actor.companyId, parsed.data),
      { isolationLevel: "RepeatableRead" },
    );
    return privateJson(json({ range: parsed.data, ...report }));
  };
  return { ageing: ageingRead, cash: cashRead };
}
