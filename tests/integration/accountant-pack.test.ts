import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import {
  invoiceDocument,
  pdfInput,
  renderInvoicePdf,
} from "../../apps/web/src/server/invoices/pdf";
import { receiptHandlers } from "../../apps/web/src/server/receipts/handlers";
import {
  billHandlers,
  supplierPaymentHandlers,
} from "../../apps/web/src/server/bills/handlers";
import { expenseHandlers } from "../../apps/web/src/server/expenses/handlers";
import { reportHandlers } from "../../apps/web/src/server/reports/handlers";
import { exportHandlers } from "../../apps/web/src/server/exports/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import type { Actor } from "../../packages/authz/src/index";
import { syntheticFactory } from "../helpers/factories";
import { syntheticAbn } from "../helpers/abn";

// Accountant review pack (#67): the GST.md combined fixture, built through
// the real handlers, asserted against docs/GST.md, and — when
// ACCOUNTANT_PACK_DIR is set — written out as the sample tax invoices and
// draft GST/BAS exports the accountant reviews
// (docs/research/accountant-review-pack.md). Synthetic data only.

const origin = "http://127.0.0.1:3000",
  password = "Synthetic-Accountant-Pack-2026!";
const out = process.env.ACCOUNTANT_PACK_DIR;
let database: CommittedDatabase, db: PrismaClient;
const factory = syntheticFactory(6767);
beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
});
afterAll(() => database?.release());
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (data?: unknown) =>
  new Request(`${origin}/api/test`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(data ?? {}),
  });
const ok = async (response: Response, status: number) => {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<{ id: string }>;
};

type Variant = {
  name: string;
  registered: boolean;
  basis: "cash" | "non_cash";
};

/** GST.md's combined fixture, settlements included, dated July 2026. */
async function build({ registered, basis }: Variant) {
  const user = await createCredentialUser(db, {
    email: `pack-${randomUUID()}@example.test`,
    name: "Synthetic Owner",
    password,
  });
  const company = factory.company(user.id);
  await db.$transaction(async (tx) => {
    await tx.company.create({
      data: {
        ...company,
        legalName: "Sample Contracting Pty Ltd",
        abn: syntheticAbn("676767676"),
        addressLine1: "1 Synthetic Road",
        suburb: "Testville",
        state: "NSW",
        postcode: "2000",
      },
    });
    await tx.membership.create({
      data: factory.membership(company.id, user.id),
    });
  });
  const actor: Actor = {
    companyId: company.id,
    userId: user.id,
    role: "owner",
  };
  if (registered)
    await db.companyGstRegistration.create({
      data: {
        companyId: company.id,
        startsOn: new Date("2026-01-01"),
        basis,
        createdBy: user.id,
      },
    });
  const taxed = registered ? "TAXABLE_10" : "OUT_OF_SCOPE";
  const customer = await db.customer.create({
    data: {
      companyId: company.id,
      name: "Sample Customer Pty Ltd",
      createdBy: user.id,
    },
  });
  const job = await db.job.create({
    data: {
      companyId: company.id,
      customerId: customer.id,
      number: 1,
      reference: "JOB-0001",
      title: "Sample bathroom renovation",
      status: "completed",
      agreedPriceExclusiveCents: 250000n,
      createdBy: user.id,
    },
  });
  const doc = async () =>
    (
      await db.document.create({
        data: {
          companyId: company.id,
          kind: "tax_invoice",
          objectKey: `documents/${company.id}/${randomBytes(32).toString("hex")}`,
          fileName: "synthetic.pdf",
          contentType: "application/pdf",
          sizeBytes: 12,
          sha256: "a".repeat(64),
          createdBy: user.id,
        },
      })
    ).id;

  // Customer tax invoice: $2,500 ex GST.
  const invoices = invoiceHandlers(() => db);
  const invoice = await ok(
    await invoices.create({
      actor,
      request: req({
        customerId: customer.id,
        jobId: job.id,
        lines: [
          {
            description: "Bathroom renovation (labour and materials)",
            quantity: "1",
            unitPriceCents: "250000",
            taxCode: taxed,
          },
        ],
      }),
      context: undefined,
    }),
    201,
  );
  await ok(
    await invoices.issue({
      actor,
      request: req({ issueDate: "2026-07-15" }),
      context: context(invoice.id),
    }),
    200,
  );

  // Subcontractor bill: $900 + $90 GST, valid tax invoice held.
  const bill = await ok(
    await billHandlers(() => db).create({
      actor,
      request: req({
        jobId: job.id,
        supplierName: "Sample Tiling Pty Ltd",
        supplierGstRegistered: registered,
        ...(registered ? { supplierAbn: syntheticAbn("676767677") } : {}),
        issuedOn: "2026-07-15",
        lines: [
          {
            description: "Tiling subcontract",
            taxCode: taxed,
            exclusiveCents: "90000",
            gstCents: registered ? "9000" : "0",
          },
        ],
        documentId: await doc(),
        evidenceVerified: true,
      }),
      context: undefined,
    }),
    201,
  );

  // Employee labour: 5 h at $60 = $300, an internal cost with no GST.
  const employee = await db.employee.create({
    data: {
      companyId: company.id,
      name: "Sample Employee",
      createdBy: user.id,
    },
  });
  const rate = await db.employeeRate.create({
    data: {
      companyId: company.id,
      employeeId: employee.id,
      effectiveFrom: new Date("2026-01-01"),
      hourlyCostCents: 6000n,
      createdBy: user.id,
    },
  });
  await db.timesheet.create({
    data: {
      companyId: company.id,
      employeeId: employee.id,
      jobId: job.id,
      workDate: new Date("2026-07-15"),
      minutes: 300,
      status: "approved",
      rateId: rate.id,
      hourlyCostCents: 6000n,
      costCents: 30000n,
      submittedBy: user.id,
      decidedBy: user.id,
      decidedAt: new Date("2026-07-15T01:00:00Z"),
    },
  });

  // Materials $150 + $15 GST (tax invoice held); travel $100, no GST.
  const expenses = expenseHandlers(() => db);
  for (const [description, category, amount, taxCode] of [
    ["Tiles and adhesive", "materials", "15000", taxed],
    ["Travel to site", "travel", "10000", "OUT_OF_SCOPE"],
  ] as const) {
    const expense = await ok(
      await expenses.create({
        actor,
        request: req({
          jobId: job.id,
          category,
          description,
          supplierName: "Sample Supplies",
          purchasedOn: "2026-07-15",
          priceEntry: "exclusive",
          amountCents: amount,
          taxCode,
          receiptDocumentId: await doc(),
          settlement: "paid_at_purchase",
          paymentMethod: "card",
        }),
        context: undefined,
      }),
      201,
    );
    await ok(
      await expenses.decide({
        actor,
        request: req({ decision: "approve", evidenceVerified: true }),
        context: context(expense.id),
      }),
      200,
    );
  }

  // Settlements: $1,000 received; $400 paid to the subcontractor.
  await ok(
    await receiptHandlers(() => db).create({
      actor,
      request: req({
        customerId: customer.id,
        receivedOn: "2026-07-20",
        amountCents: "100000",
        method: "bank_transfer",
        reference: "Sample remittance",
        allocations: [{ invoiceId: invoice.id, amountCents: "100000" }],
      }),
      context: undefined,
    }),
    201,
  );
  await ok(
    await supplierPaymentHandlers(() => db).create({
      actor,
      request: req({
        paidOn: "2026-07-20",
        amountCents: "40000",
        method: "bank_transfer",
        reference: "Sample part payment",
        allocations: [{ billId: bill.id, amountCents: "40000" }],
      }),
      context: undefined,
    }),
    201,
  );
  return { actor, invoiceId: invoice.id };
}

const range = "from=2026-07-01&to=2026-09-30";
async function report(actor: Actor, kind: "gst" | "profitability") {
  const response = await reportHandlers(() => db)[kind]({
    actor,
    request: new Request(`${origin}/api/reports?${range}`),
    context: undefined,
  });
  expect(response.status).toBe(200);
  return response.json();
}
async function exported(actor: Actor, name: string, query: string) {
  // The 5-a-minute export throttle is tested in reporting.test.ts.
  await db.$executeRaw`DELETE FROM auth_rate_limits WHERE key LIKE 'jobflow:export:%'`;
  const response = await exportHandlers(() => db).run({
    actor,
    request: new Request(`${origin}/api/exports/${name}?${query}`),
    context: { params: Promise.resolve({ name }) },
  });
  expect(response.status, name).toBe(200);
  return response.text();
}

// Expected figures, cents: docs/GST.md "Combined GST and profit acceptance
// fixture" and docs/research/domain-gst-profit.md worked examples.
const variants: (Variant & {
  title: string;
  gst: { g1: string; oneA: string; oneB: string; netGst: string };
  customerOwed: string;
  supplierOwed: string;
})[] = [
  {
    name: "registered-accrual",
    registered: true,
    basis: "non_cash",
    title: "Tax Invoice",
    // 1B = 90.00 subcontract + 15.00 materials.
    gst: { g1: "275000", oneA: "25000", oneB: "10500", netGst: "14500" },
    customerOwed: "175000",
    supplierOwed: "59000",
  },
  {
    name: "registered-cash",
    registered: true,
    basis: "cash",
    title: "Tax Invoice",
    // 1A = 1/11 of the $1,000 receipt; 1B = 1/11 of the $400 payment
    // (36.36) + the materials' 15.00, paid at purchase.
    gst: { g1: "100000", oneA: "9091", oneB: "5136", netGst: "3955" },
    customerOwed: "175000",
    supplierOwed: "59000",
  },
  {
    name: "not-registered",
    registered: false,
    basis: "non_cash",
    title: "Invoice",
    gst: { g1: "0", oneA: "0", oneB: "0", netGst: "0" },
    customerOwed: "150000",
    supplierOwed: "50000",
  },
];

describe("accountant review pack (#67)", () => {
  it.each(variants)(
    "$name: the combined fixture's profit, GST and balances",
    async (variant) => {
      const { actor, invoiceId } = await build(variant);

      // Profit is the same in every variant: GST never changes it.
      const profit = await report(actor, "profitability");
      expect(profit.totals).toMatchObject({
        revenue: "250000",
        cost: "145000",
        profit: "105000",
        marginBasisPoints: "4200",
      });
      const gst = await report(actor, "gst");
      expect(gst).toMatchObject({ ...variant.gst, incomplete: false });

      const row = await db.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        include: { items: { orderBy: { position: "asc" } } },
      });
      expect(row.title).toBe(variant.title);
      expect(row.inclusiveCents).toBe(variant.registered ? 275000n : 250000n);

      const files: Record<string, string | Uint8Array> = {
        "gst-summary.csv": await exported(actor, "gst-summary", range),
        "gst-lines.csv": await exported(actor, "gst-lines", range),
        "profitability.csv": await exported(actor, "profitability", range),
        "ageing-receivables.csv": await exported(
          actor,
          "ageing",
          "side=receivables&asAt=2026-07-31",
        ),
        "ageing-payables.csv": await exported(
          actor,
          "ageing",
          "side=payables&asAt=2026-07-31",
        ),
        "invoice.pdf": await renderInvoicePdf(
          invoiceDocument(pdfInput(row, null)),
        ),
      };
      const owed = (csv: string) =>
        csv.trim().split("\r\n").slice(1)[0]!.split(",").at(-1);
      expect(owed(files["ageing-receivables.csv"] as string)).toBe(
        variant.customerOwed,
      );
      expect(owed(files["ageing-payables.csv"] as string)).toBe(
        variant.supplierOwed,
      );
      expect(files["gst-summary.csv"]).toContain(
        "Draft BAS/GST summary — not lodged",
      );

      if (out) {
        const dir = join(out, variant.name);
        mkdirSync(dir, { recursive: true });
        for (const [file, body] of Object.entries(files))
          writeFileSync(join(dir, file), body);
      }
    },
    60_000,
  );
});
