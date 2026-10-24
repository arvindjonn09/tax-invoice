import { createHash } from "node:crypto";
import {
  type Actor,
  companyScope,
  notFound,
  requireSameCompany,
} from "@jobflow/authz";
import {
  type InvoiceBalance,
  allocationGst,
  allocationProblems,
  receivable,
  voidProblem,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  CustomerReceipt,
  Prisma,
  PrismaClient,
  ReceiptAllocation,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { invalid, jsonOrNull } from "../company/handlers";
import { sydneyToday, toDay } from "../company/gst";
import { isUniqueViolation, lockRow } from "../db/locks";
import { optionalText, requiredText, uuidOrNull } from "../http/fields";
import { parsePage } from "../http/guards";
import { Refusal, inTransaction } from "../jobs/handlers";

// #50. Money received from customers, allocated to issued invoices. Reads
// payment.read (office); writes payment.write (owner, accountant). Receipts
// never touch revenue, cost or profit. Money leaves the API as cent strings.

type Row = CustomerReceipt & { allocations: ReceiptAllocation[] };
type IdContext = { params: Promise<{ id: string }> };

const cents = z
  .union([z.string().regex(/^\d{1,13}$/, "Whole cents only"), z.number().int()])
  .transform((value) => BigInt(value));

const CreateReceipt = z.object({
  customerId: z.uuid("Choose a customer"),
  kind: z.enum(["receipt", "refund"]).default("receipt"),
  receivedOn: z.iso.date("Use a date like 2026-07-01"),
  amountCents: cents,
  method: z.enum(["bank_transfer", "card", "cash", "cheque", "other"]),
  reference: optionalText(100).optional(),
  allocations: z
    .array(z.object({ invoiceId: z.uuid(), amountCents: cents }))
    .max(100),
});
const Void = z.object({ reason: requiredText(500, "Say why it's void") });

/** Client-chosen, opaque; the same key replays the same receipt. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    {
      status,
    },
  );

function view(row: Row) {
  return {
    id: row.id,
    customerId: row.customerId,
    kind: row.kind,
    receivedOn: toDay(row.receivedOn),
    amountCents: row.amountCents.toString(),
    method: row.method,
    reference: row.reference,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    createdAt: row.createdAt,
    allocations: row.allocations.map((allocation) => ({
      invoiceId: allocation.invoiceId,
      amountCents: allocation.amountCents.toString(),
      gstAttributedCents: allocation.gstAttributedCents.toString(),
    })),
  };
}

/** Stable fingerprint of what was asked for (keys sorted, cents as strings). */
function fingerprint(data: z.infer<typeof CreateReceipt>): string {
  const canonical = {
    customerId: data.customerId,
    kind: data.kind,
    receivedOn: data.receivedOn,
    amountCents: data.amountCents.toString(),
    method: data.method,
    reference: data.reference ?? null,
    allocations: [...data.allocations]
      .map((a) => [a.invoiceId, a.amountCents.toString()])
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Current balances of issued invoices (credits and net received), for the
 * given ids in this company. Callers lock the invoice rows first.
 */
export async function invoiceBalances(
  db: Prisma.TransactionClient | PrismaClient,
  companyId: string,
  invoiceIds: readonly string[],
  customerId?: string,
): Promise<Map<string, InvoiceBalance>> {
  const invoices = await db.invoice.findMany({
    where: {
      companyId,
      id: { in: [...invoiceIds] },
      kind: "invoice",
      status: "issued",
      ...(customerId ? { customerId } : {}),
    },
    select: { id: true, inclusiveCents: true, gstCents: true },
  });
  const ids = invoices.map((invoice) => invoice.id);
  const [credits, allocations] = await Promise.all([
    db.invoice.groupBy({
      by: ["creditsId"],
      where: { companyId, creditsId: { in: ids }, status: "issued" },
      _sum: { inclusiveCents: true },
    }),
    db.receiptAllocation.findMany({
      where: { companyId, invoiceId: { in: ids }, receipt: { voidedAt: null } },
      select: {
        invoiceId: true,
        amountCents: true,
        receipt: { select: { kind: true } },
      },
    }),
  ]);
  const credited = new Map(
    credits.map((row) => [row.creditsId!, row._sum.inclusiveCents ?? 0n]),
  );
  const received = new Map<string, bigint>();
  for (const allocation of allocations) {
    const sign = allocation.receipt.kind === "refund" ? -1n : 1n;
    received.set(
      allocation.invoiceId,
      (received.get(allocation.invoiceId) ?? 0n) +
        sign * allocation.amountCents,
    );
  }
  return new Map(
    invoices.map((invoice) => [
      invoice.id,
      {
        invoiceId: invoice.id,
        inclusive: invoice.inclusiveCents,
        gst: invoice.gstCents,
        credited: credited.get(invoice.id) ?? 0n,
        received: received.get(invoice.id) ?? 0n,
      },
    ]),
  );
}

/** Lock invoice rows in a fixed order (no deadlocks between receipts). */
async function lockInvoices(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
) {
  for (const id of [...new Set(ids)].sort()) await lockRow(tx, "invoices", id);
}

async function replay(
  db: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  key: string,
  hash: string,
): Promise<Response | null> {
  const existing = await db.customerReceipt.findUnique({
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
      "That Idempotency-Key was already used for a different receipt",
    );
  const response = privateJson(view(existing), { status: 200 });
  response.headers.set("idempotent-replayed", "true");
  return response;
}

export function receiptHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const customerId = uuidOrNull(params.get("customerId") ?? "");
    const filter: Prisma.CustomerReceiptWhereInput = customerId
      ? { customerId }
      : {};
    const where: Prisma.CustomerReceiptWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().customerReceipt.findMany({
        where,
        include: { allocations: true },
        orderBy: [{ receivedOn: "desc" }, { createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().customerReceipt.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      receipts: rows.map(view),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id
        ? await db().customerReceipt.findUnique({
            where: { id },
            include: { allocations: true },
          })
        : null,
    );
    return privateJson(view(row));
  };

  /**
   * Record a receipt (or refund) and its allocations in one transaction.
   * Requires an Idempotency-Key header: retrying the same request — even
   * concurrently — returns the one receipt; reusing the key for a different
   * request is refused.
   */
  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const key = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(key))
      return fail(
        400,
        "Send an Idempotency-Key header (8–200 letters, digits or -_.:)",
      );
    const parsed = CreateReceipt.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    if (data.receivedOn > sydneyToday())
      return fail(400, "The date can't be in the future", "receivedOn");
    const hash = fingerprint(data);
    const earlier = await replay(db(), actor, key, hash);
    if (earlier) return earlier;
    try {
      return await inTransaction(async () => {
        const row = await withAudit(db(), async (tx, audit) => {
          const customer = await tx.customer.findFirst({
            where: { id: data.customerId, companyId: actor.companyId },
            select: { id: true },
          });
          if (!customer)
            throw new Refusal(fail(400, "Choose a customer", "customerId"));
          const ids = data.allocations.map((a) => a.invoiceId);
          await lockInvoices(tx, ids);
          // A concurrent duplicate may have committed while we waited for the
          // invoice locks: replay it rather than judging it as an overpayment.
          const duplicate = await replay(tx, actor, key, hash);
          if (duplicate) throw new Refusal(duplicate);
          const balances = await invoiceBalances(
            tx,
            actor.companyId,
            ids,
            customer.id,
          );
          const allocations = data.allocations.map((a) => ({
            invoiceId: a.invoiceId,
            amount: a.amountCents,
          }));
          const problems = allocationProblems(
            data.kind,
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
          const created = await tx.customerReceipt.create({
            data: {
              companyId: actor.companyId,
              customerId: customer.id,
              kind: data.kind,
              receivedOn: new Date(`${data.receivedOn}T00:00:00Z`),
              amountCents: data.amountCents,
              method: data.method,
              reference: data.reference ?? null,
              idempotencyKey: key,
              requestHash: hash,
              createdBy: actor.userId,
            },
          });
          await tx.receiptAllocation.createMany({
            data: allocations.map((allocation) => ({
              companyId: actor.companyId,
              receiptId: created.id,
              invoiceId: allocation.invoiceId,
              amountCents: allocation.amount,
              gstAttributedCents: allocationGst(
                data.kind,
                allocation.amount,
                balances.get(allocation.invoiceId)!,
              ),
            })),
          });
          await audit({
            companyId: actor.companyId,
            actorUserId: actor.userId,
            action:
              data.kind === "receipt" ? "receipt.recorded" : "refund.recorded",
            target: { type: "customer_receipt", id: created.id },
            after: {
              customerId: customer.id,
              amountCents: data.amountCents,
              allocations: allocations.map((a) => ({
                invoiceId: a.invoiceId,
                amountCents: a.amount,
              })),
            },
          });
          return tx.customerReceipt.findUniqueOrThrow({
            where: { id: created.id },
            include: { allocations: true },
          });
        });
        return privateJson(view(row), { status: 201 });
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

  /**
   * Void a receipt or refund (audited, final). A receipt can't be voided if
   * refunds already returned that money — void the refund first.
   */
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
        await lockRow(tx, "customer_receipts", id);
        const before = requireSameCompany(
          actor,
          await tx.customerReceipt.findUnique({
            where: { id },
            include: { allocations: true },
          }),
        );
        if (before.voidedAt) throw new Refusal(fail(409, "It's already void"));
        const ids = before.allocations.map((a) => a.invoiceId);
        await lockInvoices(tx, ids);
        // Under the invoice locks, the money left after this void must stay
        // between nothing and what's due, for receipts and refunds alike.
        const balances = await invoiceBalances(tx, actor.companyId, ids);
        for (const allocation of before.allocations) {
          const balance = balances.get(allocation.invoiceId);
          const problem =
            balance &&
            voidProblem(before.kind, balance, allocation.amountCents);
          if (problem) throw new Refusal(fail(409, problem));
        }
        const updated = await tx.customerReceipt.update({
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
          action:
            before.kind === "receipt" ? "receipt.voided" : "refund.voided",
          target: { type: "customer_receipt", id },
          after: { reason: parsed.data.reason },
        });
        return updated;
      });
      return privateJson(view(row));
    });
  };

  return { list, read, create, void: voidIt };
}

/** Received and still-owing amounts for one issued invoice (cent strings). */
export async function invoiceMoney(
  db: PrismaClient,
  companyId: string,
  invoiceId: string,
): Promise<{ receivedCents: string; outstandingCents: string } | null> {
  const balance = (await invoiceBalances(db, companyId, [invoiceId])).get(
    invoiceId,
  );
  if (!balance) return null;
  return {
    receivedCents: balance.received.toString(),
    outstandingCents: receivable(balance).toString(),
  };
}
