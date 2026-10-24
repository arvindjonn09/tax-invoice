import {
  type Actor,
  companyScope,
  notFound,
  requireSameCompany,
} from "@jobflow/authz";
import {
  type GstLine,
  type InvoiceLineInput,
  TAX_CODES,
  type TaxCode,
  creditableRemaining,
  documentTotals,
  invoiceLines,
  invoiceTitle,
  issueProblems,
  transitionProblem,
} from "@jobflow/domain";
import { z } from "zod";
import type {
  Invoice,
  InvoiceItem,
  Prisma,
  PrismaClient,
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
import { invoiceMoney } from "../receipts/handlers";

// #47. Office roles read (invoice.read); owner/manager/accountant draft
// (invoice.write); owner/accountant issue, credit and void (invoice.issue).
// Money leaves the API as integer-cent strings.

type Row = Invoice & { items: InvoiceItem[] };
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

const Line = z.object({
  description: requiredText(500, "Describe what was supplied"),
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,9}(\.\d{1,4})?$/, "Up to 4 decimal places")
    .refine((value) => /[1-9]/.test(value), "Quantity must be more than 0"),
  unit: optionalText(20).optional(),
  unitPriceCents: cents,
  taxCode: z.enum(TAX_CODES as [TaxCode, ...TaxCode[]]),
});

const header = {
  jobId: z.uuid().nullable(),
  locationId: z.uuid().nullable(),
  priceEntry: z.enum(["exclusive", "inclusive"]),
  customerReference: optionalText(100),
  notes: optionalText(2000),
  dueOn: z.iso.date().nullable(),
  lines: z.array(Line).max(200),
};
const CreateInvoice = z
  .object({ customerId: z.uuid("Choose a customer"), ...header })
  .partial()
  .required({ customerId: true });
const UpdateInvoice = z
  .object(header)
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to update");
const Issue = z.object({ issueDate: z.iso.date().optional() });
const Void = z.object({ reason: requiredText(500, "Say why it's void") });
const CreditNote = z.object({
  lines: z.array(Line).min(1).max(200).optional(),
  notes: optionalText(2000).optional(),
});

const STATUS = z.enum(["draft", "issued", "void"]).optional().catch(undefined);
const KIND = z.enum(["invoice", "credit_note"]).optional().catch(undefined);

const fail = (status: 400 | 409, error: string, field?: string) =>
  privateJson(
    { error, ...(field ? { fields: { [field]: error } } : {}) },
    {
      status,
    },
  );

const money = (value: bigint) => value.toString();
const day = (value: Date | null) => (value ? toDay(value) : null);

function view(row: Row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    customerId: row.customerId,
    jobId: row.jobId,
    locationId: row.locationId,
    creditsId: row.creditsId,
    priceEntry: row.priceEntry,
    customerReference: row.customerReference,
    notes: row.notes,
    dueOn: day(row.dueOn),
    number: row.number,
    reference: row.reference,
    issueDate: day(row.issueDate),
    title: row.title,
    gstRegistered: row.gstRegistered,
    supplier: row.supplierSnapshot,
    customer: row.customerSnapshot,
    site: row.siteSnapshot,
    exclusiveCents: money(row.exclusiveCents),
    gstCents: money(row.gstCents),
    inclusiveCents: money(row.inclusiveCents),
    issuedAt: row.issuedAt,
    voidReason: row.voidReason,
    voidedAt: row.voidedAt,
    lines: [...row.items]
      .sort((a, b) => a.position - b.position)
      .map((item) => ({
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
      })),
  };
}

type LineInput = z.infer<typeof Line>;

/**
 * Price draft lines. A draft is priced as if registered (so Taxable lines
 * show their GST while editing); issue re-prices against the registration
 * on the issue date and refuses GST if unregistered.
 */
function priced(
  lines: readonly LineInput[],
  priceEntry: "exclusive" | "inclusive",
) {
  const amounts = invoiceLines(lines.map(toDomain), priceEntry, true);
  return { amounts, totals: documentTotals(amounts) };
}

const toDomain = (line: LineInput): InvoiceLineInput => ({
  description: line.description,
  quantity: line.quantity,
  unitPrice: line.unitPriceCents,
  taxCode: line.taxCode,
});

function itemRows(
  companyId: string,
  invoiceId: string,
  lines: readonly LineInput[],
  amounts: readonly GstLine[],
): Prisma.InvoiceItemCreateManyInput[] {
  return lines.map((line, position) => {
    const amount = amounts[position]!;
    return {
      companyId,
      invoiceId,
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
    };
  });
}

async function lockedInvoice(
  tx: Prisma.TransactionClient,
  actor: Actor,
  id: string | null,
): Promise<Row> {
  if (!id) throw notFound();
  await lockRow(tx, "invoices", id).catch(() => undefined);
  return requireSameCompany(
    actor,
    await tx.invoice.findUnique({ where: { id }, include: { items: true } }),
  );
}

/** Job and site must belong to this customer of this company. */
async function partiesProblem(
  db: Prisma.TransactionClient,
  companyId: string,
  customerId: string,
  jobId: string | null | undefined,
  locationId: string | null | undefined,
): Promise<[string, string] | null> {
  const customer = await db.customer.findFirst({
    where: { id: customerId, companyId },
    select: { id: true },
  });
  if (!customer) return ["customerId", "Choose a customer"];
  if (jobId) {
    const job = await db.job.findFirst({
      where: { id: jobId, companyId, customerId },
      select: { id: true },
    });
    if (!job) return ["jobId", "Choose one of this customer's jobs"];
  }
  if (locationId) {
    const site = await db.location.findFirst({
      where: { id: locationId, companyId, customerId },
      select: { id: true },
    });
    if (!site) return ["locationId", "Choose one of this customer's sites"];
  }
  return null;
}

const refuse = (problem: [string, string]) =>
  new Refusal(fail(400, problem[1], problem[0]));

/** Integer cents as "$1,234.56" for messages; never via floating point. */
function dollars(cents: bigint): string {
  const whole = new Intl.NumberFormat("en-AU").format(cents / 100n);
  return `$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function invoiceHandlers(db: () => PrismaClient) {
  const list: PolicyHandler<unknown> = async ({ actor, request }) => {
    const params = new URL(request.url).searchParams;
    const { page, take, skip } = parsePage(params);
    const status = STATUS.parse(params.get("status") ?? undefined);
    const kind = KIND.parse(params.get("kind") ?? undefined);
    const customerId = uuidOrNull(params.get("customerId") ?? "");
    const jobId = uuidOrNull(params.get("jobId") ?? "");
    const filter: Prisma.InvoiceWhereInput = {
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(customerId ? { customerId } : {}),
      ...(jobId ? { jobId } : {}),
    };
    const where: Prisma.InvoiceWhereInput = companyScope(actor, filter);
    const [rows, total] = await Promise.all([
      db().invoice.findMany({
        where,
        include: { items: true },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take,
        skip,
      }),
      db().invoice.count({ where }),
    ]);
    return privateJson({
      page,
      pageSize: take,
      total,
      invoices: rows.map(view),
    });
  };

  const read: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    const row = requireSameCompany(
      actor,
      id
        ? await db().invoice.findUnique({
            where: { id },
            include: { items: true },
          })
        : null,
    );
    const credits = await db().invoice.findMany({
      where: { companyId: actor.companyId, creditsId: row.id },
      select: { id: true, status: true, reference: true, inclusiveCents: true },
    });
    const money_ =
      row.kind === "invoice" && row.status === "issued"
        ? await invoiceMoney(db(), actor.companyId, row.id)
        : null;
    return privateJson({
      ...view(row),
      ...(money_ ?? {}),
      creditNotes: credits.map((credit) => ({
        ...credit,
        inclusiveCents: money(credit.inclusiveCents),
      })),
    });
  };

  const create: PolicyHandler<unknown> = async ({ actor, request }) => {
    const parsed = CreateInvoice.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    const lines = data.lines ?? [];
    const priceEntry = data.priceEntry ?? "exclusive";
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const problem = await partiesProblem(
          tx,
          actor.companyId,
          data.customerId,
          data.jobId,
          data.locationId,
        );
        if (problem) throw refuse(problem);
        const { amounts, totals } = priced(lines, priceEntry);
        const created = await tx.invoice.create({
          data: {
            companyId: actor.companyId,
            customerId: data.customerId,
            jobId: data.jobId ?? null,
            locationId: data.locationId ?? null,
            priceEntry,
            customerReference: data.customerReference ?? null,
            notes: data.notes ?? null,
            dueOn: data.dueOn ? new Date(`${data.dueOn}T00:00:00Z`) : null,
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            createdBy: actor.userId,
          },
        });
        await tx.invoiceItem.createMany({
          data: itemRows(actor.companyId, created.id, lines, amounts),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "invoice.drafted",
          target: { type: "invoice", id: created.id },
          after: {
            customerId: created.customerId,
            jobId: created.jobId,
            inclusiveCents: totals.inclusive,
          },
        });
        return tx.invoice.findUniqueOrThrow({
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
    const parsed = UpdateInvoice.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const data = parsed.data;
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedInvoice(tx, actor, id);
        if (before.status !== "draft")
          throw new Refusal(
            fail(409, "An issued invoice can't be edited. Credit or void it."),
          );
        const jobId = data.jobId === undefined ? before.jobId : data.jobId;
        const locationId =
          data.locationId === undefined ? before.locationId : data.locationId;
        const problem = await partiesProblem(
          tx,
          actor.companyId,
          before.customerId,
          jobId,
          locationId,
        );
        if (problem) throw refuse(problem);
        const priceEntry = data.priceEntry ?? before.priceEntry;
        const lines =
          data.lines ??
          [...before.items]
            .sort((a, b) => a.position - b.position)
            .map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unitPriceCents: item.unitPriceCents,
              taxCode: item.taxCode,
            }));
        const { amounts, totals } = priced(lines, priceEntry);
        await tx.invoiceItem.deleteMany({ where: { invoiceId: before.id } });
        await tx.invoiceItem.createMany({
          data: itemRows(actor.companyId, before.id, lines, amounts),
        });
        await tx.invoice.update({
          where: { id: before.id },
          data: {
            jobId,
            locationId,
            priceEntry,
            ...(data.customerReference !== undefined
              ? { customerReference: data.customerReference }
              : {}),
            ...(data.notes !== undefined ? { notes: data.notes } : {}),
            ...(data.dueOn !== undefined
              ? {
                  dueOn: data.dueOn
                    ? new Date(`${data.dueOn}T00:00:00Z`)
                    : null,
                }
              : {}),
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
          },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "invoice.draft_updated",
          target: { type: "invoice", id: before.id },
          before: {
            inclusiveCents: before.inclusiveCents,
            lines: before.items.length,
          },
          after: { inclusiveCents: totals.inclusive, lines: lines.length },
        });
        return tx.invoice.findUniqueOrThrow({
          where: { id: before.id },
          include: { items: true },
        });
      });
      return privateJson(view(row));
    });
  };

  /** Discard a draft (issued documents are never deleted). */
  const discard: PolicyHandler<IdContext> = async ({ actor, context }) => {
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      await withAudit(db(), async (tx, audit) => {
        const before = await lockedInvoice(tx, actor, id);
        if (before.status !== "draft")
          throw new Refusal(fail(409, "Only a draft can be discarded"));
        await tx.invoiceItem.deleteMany({ where: { invoiceId: before.id } });
        await tx.invoice.delete({ where: { id: before.id } });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "invoice.draft_discarded",
          target: { type: "invoice", id: before.id },
          before: { inclusiveCents: before.inclusiveCents },
        });
      });
      return privateJson({ discarded: true });
    });
  };

  /**
   * Issue: validate against GST registration on the issue date, assign the
   * next number, snapshot supplier/customer/site and freeze everything. A
   * completed job becomes "invoiced" (a system move).
   */
  const issue: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Issue.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const issueDate = parsed.data.issueDate ?? sydneyToday();
    if (issueDate > sydneyToday())
      return fail(400, "The issue date can't be in the future", "issueDate");
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedInvoice(tx, actor, id);
        if (before.status !== "draft")
          throw new Refusal(fail(409, "It's already issued"));
        const [company, customer, site, status] = await Promise.all([
          tx.company.findUniqueOrThrow({ where: { id: actor.companyId } }),
          tx.customer.findUniqueOrThrow({ where: { id: before.customerId } }),
          before.locationId
            ? tx.location.findUnique({ where: { id: before.locationId } })
            : Promise.resolve(null),
          companyGstStatusOn(tx, actor.companyId, issueDate),
        ]);
        // A credit note reverses the original supply, so it takes the
        // original's GST treatment. Lock before reading so a concurrent
        // void is seen.
        let original: Invoice | null = null;
        if (before.kind === "credit_note") {
          await lockRow(tx, "invoices", before.creditsId!);
          original = await tx.invoice.findUniqueOrThrow({
            where: { id: before.creditsId! },
          });
          if (original.status !== "issued")
            throw new Refusal(
              fail(409, "Only an issued invoice can be credited"),
            );
        }
        // Issued invoices always carry their registration (DB-checked).
        const registered = original?.gstRegistered ?? status.registered;
        const items = [...before.items].sort((a, b) => a.position - b.position);
        const inputs = items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPriceCents,
          taxCode: item.taxCode,
        }));
        const problems = issueProblems({
          registered,
          supplier: { legalName: company.legalName, abn: company.abn },
          recipient: { name: customer.name, abn: customer.abn },
          lines: inputs,
          inclusive: before.inclusiveCents,
        });
        if (problems.length > 0)
          throw new Refusal(
            privateJson(
              {
                error: "Fix these before issuing",
                fields: Object.fromEntries(
                  problems.map((p) => [p.field, p.message]),
                ),
              },
              { status: 400 },
            ),
          );
        // Re-price against the registration on the issue date (or, for a
        // credit note, the original invoice's).
        const amounts = invoiceLines(inputs, before.priceEntry, registered);
        const totals = documentTotals(amounts);
        if (original) {
          const issuedCredits = await tx.invoice.findMany({
            where: { creditsId: original.id, status: "issued" },
            select: { inclusiveCents: true },
          });
          const remaining = creditableRemaining(
            original.inclusiveCents,
            issuedCredits.map((credit) => credit.inclusiveCents),
          );
          if (totals.inclusive > remaining)
            throw new Refusal(
              fail(
                400,
                `Credits can't exceed what's left on the invoice (${dollars(remaining)})`,
                "lines",
              ),
            );
        }
        // Lines were priced as registered while drafting; store issue amounts.
        await tx.invoiceItem.deleteMany({ where: { invoiceId: before.id } });
        await tx.invoiceItem.createMany({
          data: itemRows(
            actor.companyId,
            before.id,
            items.map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unitPriceCents: item.unitPriceCents,
              taxCode: item.taxCode,
            })),
            amounts,
          ),
        });
        const kind = before.kind === "credit_note" ? "credit_note" : "invoice";
        const number = await nextNumber(tx, actor.companyId, kind);
        const prefix = kind === "invoice" ? company.invoicePrefix : "CN-";
        const title =
          kind === "invoice"
            ? invoiceTitle(registered)
            : registered
              ? "Adjustment Note"
              : "Credit Note";
        const updated = await tx.invoice.update({
          where: { id: before.id },
          data: {
            status: "issued",
            number,
            reference: `${prefix}${String(number).padStart(4, "0")}`,
            issueDate: new Date(`${issueDate}T00:00:00Z`),
            title,
            gstRegistered: registered,
            supplierSnapshot: {
              name: company.name,
              legalName: company.legalName,
              abn: company.abn,
              addressLine1: company.addressLine1,
              addressLine2: company.addressLine2,
              suburb: company.suburb,
              state: company.state,
              postcode: company.postcode,
            },
            customerSnapshot: {
              name: customer.name,
              abn: customer.abn,
              billingEmail: customer.billingEmail,
              addressLine1: customer.addressLine1,
              addressLine2: customer.addressLine2,
              suburb: customer.suburb,
              state: customer.state,
              postcode: customer.postcode,
            },
            ...(site
              ? {
                  siteSnapshot: {
                    label: site.label,
                    addressLine1: site.addressLine1,
                    addressLine2: site.addressLine2,
                    suburb: site.suburb,
                    state: site.state,
                    postcode: site.postcode,
                  },
                }
              : {}),
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            issuedAt: new Date(),
            issuedBy: actor.userId,
          },
          include: { items: true },
        });
        if (kind === "invoice" && updated.jobId) {
          await lockRow(tx, "jobs", updated.jobId);
          const job = await tx.job.findUniqueOrThrow({
            where: { id: updated.jobId },
          });
          if (!transitionProblem(job.status, "invoiced", { bySystem: true })) {
            await tx.job.update({
              where: { id: job.id },
              data: { status: "invoiced" },
            });
            await tx.jobStatusEvent.create({
              data: {
                companyId: actor.companyId,
                jobId: job.id,
                fromStatus: job.status,
                toStatus: "invoiced",
                note: `Invoice ${updated.reference} issued`,
                createdBy: actor.userId,
              },
            });
          }
        }
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: kind === "invoice" ? "invoice.issued" : "credit_note.issued",
          target: { type: "invoice", id: updated.id },
          after: {
            reference: updated.reference,
            title,
            gstRegistered: registered,
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
          },
        });
        return updated;
      });
      return privateJson(view(row));
    });
  };

  /**
   * Draft a credit note for an issued invoice. Without lines it copies the
   * invoice's lines (a full credit); either way issue checks the total
   * against what's still creditable.
   */
  const credit: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = CreditNote.safeParse((await jsonOrNull(request)) ?? {});
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const original = await lockedInvoice(tx, actor, id);
        if (original.kind !== "invoice" || original.status !== "issued")
          throw new Refusal(
            fail(409, "Only an issued invoice can be credited"),
          );
        const lines =
          parsed.data.lines ??
          [...original.items]
            .sort((a, b) => a.position - b.position)
            .map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unitPriceCents: item.unitPriceCents,
              taxCode: item.taxCode,
            }));
        const { amounts, totals } = priced(lines, original.priceEntry);
        const created = await tx.invoice.create({
          data: {
            companyId: actor.companyId,
            kind: "credit_note",
            customerId: original.customerId,
            jobId: original.jobId,
            locationId: original.locationId,
            creditsId: original.id,
            priceEntry: original.priceEntry,
            customerReference: original.customerReference,
            notes: parsed.data.notes ?? null,
            exclusiveCents: totals.exclusive,
            gstCents: totals.gst,
            inclusiveCents: totals.inclusive,
            createdBy: actor.userId,
          },
        });
        await tx.invoiceItem.createMany({
          data: itemRows(actor.companyId, created.id, lines, amounts),
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action: "credit_note.drafted",
          target: { type: "invoice", id: created.id },
          after: { creditsId: original.id, inclusiveCents: totals.inclusive },
        });
        return tx.invoice.findUniqueOrThrow({
          where: { id: created.id },
          include: { items: true },
        });
      });
      return privateJson(view(row), { status: 201 });
    });
  };

  /**
   * Void an issued document with a reason (audited, final). An invoice with
   * issued credit notes can't be voided — the credits already correct it.
   */
  const voidIt: PolicyHandler<IdContext> = async ({
    actor,
    request,
    context,
  }) => {
    const parsed = Void.safeParse(await jsonOrNull(request));
    if (!parsed.success) return invalid(parsed.error);
    const id = uuidOrNull((await context.params).id);
    return inTransaction(async () => {
      const row = await withAudit(db(), async (tx, audit) => {
        const before = await lockedInvoice(tx, actor, id);
        if (before.status !== "issued")
          throw new Refusal(
            fail(
              409,
              before.status === "draft"
                ? "Discard a draft instead"
                : "It's already void",
            ),
          );
        if (
          before.kind === "invoice" &&
          (await tx.invoice.count({
            where: { creditsId: before.id, status: "issued" },
          })) > 0
        )
          throw new Refusal(
            fail(
              409,
              "This invoice has issued credit notes; credit the rest instead of voiding",
            ),
          );
        if (
          (await tx.receiptAllocation.count({
            where: { invoiceId: before.id, receipt: { voidedAt: null } },
          })) > 0
        )
          throw new Refusal(
            fail(
              409,
              "Money has been received against this invoice; credit it, or void the receipts first",
            ),
          );
        const updated = await tx.invoice.update({
          where: { id: before.id },
          data: {
            status: "void",
            voidReason: parsed.data.reason,
            voidedAt: new Date(),
            voidedBy: actor.userId,
          },
          include: { items: true },
        });
        await audit({
          companyId: actor.companyId,
          actorUserId: actor.userId,
          action:
            before.kind === "invoice" ? "invoice.voided" : "credit_note.voided",
          target: { type: "invoice", id: before.id },
          before: { status: "issued" },
          after: { status: "void", reason: parsed.data.reason },
        });
        return updated;
      });
      return privateJson(view(row));
    });
  };

  return { list, read, create, update, discard, issue, credit, void: voidIt };
}
