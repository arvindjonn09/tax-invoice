import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import {
  createWithPolicy,
  isLockedPeriodError,
} from "../../apps/web/src/server/authz/policy";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import { quoteHandlers } from "../../apps/web/src/server/quotes/handlers";
import { receiptHandlers } from "../../apps/web/src/server/receipts/handlers";
import {
  billHandlers,
  supplierCreditHandlers,
  supplierPaymentHandlers,
} from "../../apps/web/src/server/bills/handlers";
import { expenseHandlers } from "../../apps/web/src/server/expenses/handlers";
import { periodHandlers } from "../../apps/web/src/server/reports/periods";
import { sydneyToday } from "../../apps/web/src/server/company/gst";
import { reportHandlers } from "../../apps/web/src/server/reports/handlers";
import { ledgerHandlers } from "../../apps/web/src/server/reports/ledger";
import { exportHandlers } from "../../apps/web/src/server/exports/handlers";
import {
  withCommittedDatabase,
  type CommittedDatabase,
} from "../helpers/committed-database";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import type { Actor, Role } from "../../packages/authz/src/index";
import { syntheticFactory } from "../helpers/factories";
import { syntheticAbn } from "../helpers/abn";
const origin = "http://127.0.0.1:3000",
  password = "Synthetic-Reporting-Tests-2026!";
let database: CommittedDatabase, db: PrismaClient;
const factory = syntheticFactory(5455);
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
async function fixture(registered: boolean, basis: "cash" | "non_cash") {
  const user = await createCredentialUser(db, {
    email: `report-${randomUUID()}@example.test`,
    name: "Synthetic Reporter",
    password,
  });
  const company = factory.company(user.id);
  await db.$transaction(async (tx) => {
    await tx.company.create({
      data: {
        ...company,
        legalName: "Synthetic Contracting",
        abn: syntheticAbn("545454545"),
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
  const customer = await db.customer.create({
    data: {
      companyId: company.id,
      name: "Synthetic Customer",
      createdBy: user.id,
    },
  });
  const job = await db.job.create({
    data: {
      companyId: company.id,
      customerId: customer.id,
      number: 1,
      reference: "JOB-0001",
      title: "Synthetic Fixture",
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
  const line = {
    description: "Synthetic work",
    quantity: "1",
    unitPriceCents: "250000",
    taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
  };
  const inv = invoiceHandlers(() => db);
  const draft = await inv.create({
    actor,
    request: req({ customerId: customer.id, jobId: job.id, lines: [line] }),
    context: undefined,
  });
  expect(draft.status).toBe(201);
  const invoice = (await draft.json()) as { id: string };
  const issued = await inv.issue({
    actor,
    request: req({ issueDate: "2026-07-15" }),
    context: context(invoice.id),
  });
  expect(issued.status, await issued.clone().text()).toBe(200);
  const contractor = await db.contractor.create({
    data: {
      companyId: company.id,
      name: "Synthetic Contractor",
      gstRegistered: registered,
      abn: registered ? syntheticAbn("545454546") : null,
      createdBy: user.id,
    },
  });
  const offer = await db.contractorOffer.create({
    data: {
      companyId: company.id,
      jobId: job.id,
      contractorId: contractor.id,
      scope: "Synthetic accepted work",
      rateType: "fixed",
      rateExclusiveCents: 90000n,
      taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
      status: "accepted",
      respondedBy: user.id,
      respondedAt: new Date("2026-07-15T00:00:00Z"),
      createdBy: user.id,
    },
  });
  await db.contractorAcceptance.create({
    data: {
      companyId: company.id,
      jobId: job.id,
      offerId: offer.id,
      contractorId: contractor.id,
      rateType: "fixed",
      rateExclusiveCents: 90000n,
      taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
      gstRateBasisPoints: registered ? 1000 : 0,
      exclusiveCents: 90000n,
      gstCents: registered ? 9000n : 0n,
      inclusiveCents: registered ? 99000n : 90000n,
      contractorGstRegistered: registered,
      companyGstRegistered: registered,
      committedCostCents: 90000n,
      acceptedAt: new Date("2026-07-15T00:00:00Z"),
      acceptedBy: user.id,
    },
  });
  const bill = await billHandlers(() => db).create({
    actor,
    request: req({
      jobId: job.id,
      contractorId: contractor.id,
      offerId: offer.id,
      supplierName: "Synthetic Contractor",
      supplierGstRegistered: registered,
      ...(registered ? { supplierAbn: syntheticAbn("545454546") } : {}),
      issuedOn: "2026-07-15",
      lines: [
        {
          description: "Synthetic subcontract",
          taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
          exclusiveCents: "90000",
          gstCents: registered ? "9000" : "0",
        },
      ],
      documentId: await doc(),
      evidenceVerified: true,
    }),
    context: undefined,
  });
  expect(bill.status, await bill.clone().text()).toBe(201);
  const supplier = (await bill.json()) as { id: string };
  const employee = await db.employee.create({
    data: {
      companyId: company.id,
      name: "Synthetic Employee",
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
  const expenseIds: string[] = [];
  for (const [amount, taxCode] of [
    ["15000", registered ? "TAXABLE_10" : "OUT_OF_SCOPE"],
    ["10000", "OUT_OF_SCOPE"],
  ] as const) {
    const handler = expenseHandlers(() => db);
    const submitted = await handler.create({
      actor,
      request: req({
        jobId: job.id,
        category: "materials",
        description: "Synthetic purchase",
        purchasedOn: "2026-07-15",
        priceEntry: "exclusive",
        amountCents: amount,
        taxCode,
        receiptDocumentId: await doc(),
        settlement: "paid_at_purchase",
        paymentMethod: "card",
      }),
      context: undefined,
    });
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    const expense = (await submitted.json()) as { id: string };
    expenseIds.push(expense.id);
    const decision = await handler.decide({
      actor,
      request: req({ decision: "approve", evidenceVerified: true }),
      context: context(expense.id),
    });
    expect(decision.status, await decision.clone().text()).toBe(200);
  }
  return {
    actor,
    user,
    company,
    customer,
    job,
    invoice,
    supplier,
    expenseIds,
    doc,
  };
}
async function reports(actor: Actor) {
  const handler = reportHandlers(() => db),
    request = new Request(
      `${origin}/api/reports?from=2026-07-01&to=2026-09-30`,
    );
  return {
    profit: await (
      await handler.profitability({ actor, request, context: undefined })
    ).json(),
    gst: await (
      await handler.gst({ actor, request, context: undefined })
    ).json(),
  };
}
describe("database reports reconcile GST and profit together", () => {
  for (const [registered, basis] of [
    [true, "non_cash"],
    [true, "cash"],
    [false, "non_cash"],
  ] as const)
    it(`registered=${registered}, basis=${basis}`, async () => {
      const f = await fixture(registered, basis);
      const before = await reports(f.actor);
      expect(before.profit.committedCost).toBe("0");
      expect(before.profit.positions[0]).toMatchObject({
        currentAgreedRevenueExclusive: "250000",
        committedCost: "0",
      });
      expect(before.profit.totals).toMatchObject({
        revenue: "250000",
        cost: "145000",
        profit: "105000",
        marginBasisPoints: "4200",
      });
      expect(before.gst).toMatchObject({
        label: "Draft BAS/GST summary — not lodged",
        oneA: registered && basis === "non_cash" ? "25000" : "0",
        oneB: registered ? (basis === "cash" ? "1500" : "10500") : "0",
      });
      expect(
        before.profit.events.every(
          (e: { channel: string }) => !e.channel.startsWith("gst"),
        ),
      ).toBe(true);
      const received = await receiptHandlers(() => db).create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          receivedOn: "2026-07-15",
          amountCents: "100000",
          method: "bank_transfer",
          allocations: [{ invoiceId: f.invoice.id, amountCents: "100000" }],
        }),
        context: undefined,
      });
      expect(received.status).toBe(201);
      const paid = await supplierPaymentHandlers(() => db).create({
        actor: f.actor,
        request: req({
          paidOn: "2026-07-15",
          amountCents: "40000",
          method: "bank_transfer",
          allocations: [{ billId: f.supplier.id, amountCents: "40000" }],
        }),
        context: undefined,
      });
      expect(paid.status).toBe(201);
      const after = await reports(f.actor);
      expect(after.profit.totals).toMatchObject({
        profit: "105000",
        receivedInclusive: "100000",
        paidInclusive: registered ? "66500" : "65000",
      });
      if (registered && basis === "cash")
        expect(after.gst).toMatchObject({
          g1: "100000",
          oneA: "9091",
          oneB: "5136",
        });
      else expect(after.gst).toEqual(before.gst);
    }, 120000);
  for (const registered of [true, false])
    it(`compares accepted quote estimates with actuals (registered=${registered})`, async () => {
      const f = await fixture(registered, "non_cash");
      await db.$executeRaw`INSERT INTO number_sequences(company_id,kind,last_value) VALUES(${f.company.id}::uuid,'job',1)`;
      const quotes = quoteHandlers(() => db);
      const draft = await quotes.create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          title: "Synthetic estimated work",
          lines: [
            {
              description: "Synthetic estimate",
              quantity: "1",
              unitPriceCents: "250000",
              taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
              estimatedCostCents: "145000",
            },
          ],
        }),
        context: undefined,
      });
      expect(draft.status, await draft.clone().text()).toBe(201);
      const id = (await draft.json()).id as string;
      expect(
        (
          await quotes.send({
            actor: f.actor,
            request: req(),
            context: context(id),
          })
        ).status,
      ).toBe(200);
      const accepted = await quotes.accept({
        actor: f.actor,
        request: req(),
        context: context(id),
      });
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      const jobId = (await accepted.json()).jobId as string;
      const read = async (to: string) =>
        (
          await reportHandlers(() => db).profitability({
            actor: f.actor,
            request: new Request(
              `${origin}/api/reports/profitability?from=2026-01-01&to=${to}&jobId=${jobId}`,
            ),
            context: undefined,
          })
        ).json();
      const report = await read(sydneyToday());
      expect(report.positions[0].estimated).toMatchObject({
        quoteIds: [id],
        revenue: "250000",
        cost: "145000",
        profit: "105000",
        marginBasisPoints: "4200",
      });
      expect(report.totals).toMatchObject({
        revenue: "0",
        cost: "0",
        profit: "0",
        marginBasisPoints: null,
      });
      expect((await read("2026-09-30")).positions[0].estimated).toBeNull();
      // Accepted variations add their own snapshot once; draft variations do not.
      const variation = await quotes.create({
        actor: f.actor,
        request: req({
          kind: "variation",
          customerId: f.customer.id,
          jobId,
          title: "Synthetic variation",
          lines: [
            {
              description: "Additional work",
              quantity: "1",
              unitPriceCents: "20000",
              taxCode: registered ? "TAXABLE_10" : "OUT_OF_SCOPE",
              estimatedCostCents: "12000",
            },
          ],
        }),
        context: undefined,
      });
      expect(variation.status, await variation.clone().text()).toBe(201);
      const variationId = (await variation.json()).id as string;
      expect((await read(sydneyToday())).positions[0].estimated.cost).toBe(
        "145000",
      );
      expect(
        (
          await quotes.send({
            actor: f.actor,
            request: req(),
            context: context(variationId),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await quotes.accept({
            actor: f.actor,
            request: req(),
            context: context(variationId),
          })
        ).status,
      ).toBe(200);
      const after = await read(sydneyToday());
      expect(after.positions[0].estimated).toMatchObject({
        revenue: "270000",
        cost: "157000",
        profit: "113000",
        marginBasisPoints: "4185",
      });
      expect(after.positions[0].estimated.quoteIds).toHaveLength(2);
      expect(after.totals.profit).toBe("0");
    });
  for (const basis of ["cash", "non_cash"] as const)
    it(`excludes pre-registration supplies without changing profit (${basis})`, async () => {
      const f = await fixture(false, "non_cash");
      await db.companyGstRegistration.create({
        data: {
          companyId: f.company.id,
          startsOn: new Date("2026-08-01"),
          basis,
          createdBy: f.user.id,
        },
      });
      const invoices = invoiceHandlers(() => db);
      const draft = await invoices.create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          jobId: f.job.id,
          lines: [
            {
              description: "Synthetic registered supply",
              quantity: "1",
              unitPriceCents: "1000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        context: undefined,
      });
      expect(draft.status, await draft.clone().text()).toBe(201);
      const id = (await draft.json()).id as string;
      const issued = await invoices.issue({
        actor: f.actor,
        request: req({ issueDate: "2026-08-15" }),
        context: context(id),
      });
      expect(issued.status, await issued.clone().text()).toBe(200);
      const receipt = await receiptHandlers(() => db).create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          receivedOn: "2026-08-20",
          amountCents: "1100",
          method: "card",
          allocations: [{ invoiceId: id, amountCents: "1100" }],
        }),
        context: undefined,
      });
      expect(receipt.status, await receipt.clone().text()).toBe(201);
      const report = await reports(f.actor);
      expect(report.gst).toMatchObject({
        g1: "1100",
        oneA: "100",
        oneB: "0",
        netGst: "100",
      });
      expect(report.profit.totals).toMatchObject({
        revenue: "251000",
        cost: "145000",
        profit: "106000",
      });
      const before = await reportHandlers(() => db).gst({
        actor: f.actor,
        request: new Request(
          `${origin}/api/reports/gst?from=2026-07-01&to=2026-07-31`,
        ),
        context: undefined,
      });
      expect(await before.json()).toMatchObject({
        g1: "0",
        oneA: "0",
        oneB: "0",
      });
    });
  for (const [partialFirst, closeBeforeCredit] of [
    [false, false],
    [true, false],
    [true, true],
  ] as const)
    it(`cash mixed-tax credit preserves taxable attribution (partial first=${partialFirst}, closed=${closeBeforeCredit})`, async () => {
      const f = await fixture(true, "cash"),
        invoices = invoiceHandlers(() => db),
        receipts = receiptHandlers(() => db);
      const created = await invoices.create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          jobId: f.job.id,
          lines: [
            {
              description: "Synthetic taxable supply",
              quantity: "1",
              unitPriceCents: "100000",
              taxCode: "TAXABLE_10",
            },
            {
              description: "Synthetic out of scope",
              quantity: "1",
              unitPriceCents: "50000",
              taxCode: "OUT_OF_SCOPE",
            },
          ],
        }),
        context: undefined,
      });
      expect(created.status).toBe(201);
      const id = (await created.json()).id as string;
      expect(
        (
          await invoices.issue({
            actor: f.actor,
            request: req({ issueDate: "2026-08-01" }),
            context: context(id),
          })
        ).status,
      ).toBe(200);
      const receive = async (amount: string, date: string) =>
        receipts.create({
          actor: f.actor,
          request: req({
            customerId: f.customer.id,
            receivedOn: date,
            amountCents: amount,
            method: "card",
            allocations: [{ invoiceId: id, amountCents: amount }],
          }),
          context: undefined,
        });
      if (partialFirst)
        expect((await receive("80000", "2026-08-05")).status).toBe(201);
      if (!partialFirst) {
        const invalid = await invoices.credit({
          actor: f.actor,
          request: req({
            lines: [
              {
                description: "Invalid tax reclassification",
                quantity: "1",
                unitPriceCents: "120000",
                taxCode: "TAXABLE_10",
              },
            ],
          }),
          context: context(id),
        });
        expect(invalid.status).toBe(201);
        const invalidId = (await invalid.json()).id as string;
        const issue = await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-02" }),
          context: context(invalidId),
        });
        expect(issue.status).toBe(400);
        expect(
          await db.creditCashAdjustment.count({
            where: { companyId: f.company.id },
          }),
        ).toBe(0);
      }
      let finalised: unknown;
      if (closeBeforeCredit) {
        const close = await periodHandlers(() => db).close({
          actor: f.actor,
          request: req({
            from: "2026-07-01",
            to: "2026-09-30",
            note: "Synthetic credit boundary",
          }),
          context: undefined,
        });
        expect(close.status).toBe(201);
        finalised = (await reports(f.actor)).gst;
      }
      const read = async () => {
        if (!closeBeforeCredit) return reports(f.actor);
        const handler = reportHandlers(() => db),
          request = new Request(
            `${origin}/api/reports?from=2026-07-01&to=${sydneyToday()}`,
          );
        return {
          gst: await (
            await handler.gst({ actor: f.actor, request, context: undefined })
          ).json(),
          profit: await (
            await handler.profitability({
              actor: f.actor,
              request,
              context: undefined,
            })
          ).json(),
        };
      };
      const credit = await invoices.credit({
        actor: f.actor,
        request: req({
          lines: [
            {
              description: "Reverse out of scope only",
              quantity: "1",
              unitPriceCents: "50000",
              taxCode: "OUT_OF_SCOPE",
            },
          ],
        }),
        context: context(id),
      });
      expect(credit.status).toBe(201);
      const creditId = (await credit.json()).id as string;
      if (partialFirst) {
        const backdated = await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-04" }),
          context: context(creditId),
        });
        expect(backdated.status).toBe(400);
        expect(
          await db.creditCashAdjustment.count({
            where: { companyId: f.company.id },
          }),
        ).toBe(0);
      }
      const issued = await invoices.issue({
        actor: f.actor,
        request: req({ issueDate: "2026-08-10" }),
        context: context(creditId),
      });
      expect(issued.status, await issued.clone().text()).toBe(200);
      const receipt = await receive(
        partialFirst ? "30000" : "110000",
        "2026-08-12",
      );
      expect(receipt.status, await receipt.clone().text()).toBe(201);
      expect((await receipt.json()).allocations[0].gstAttributedCents).toBe(
        partialFirst ? "2727" : "10000",
      );
      const report = await read();
      expect(report.gst).toMatchObject({
        g1: "110000",
        oneA: "10000",
        oneB: "1500",
      });
      expect(report.profit.totals).toMatchObject({
        revenue: "350000",
        cost: "145000",
        profit: "205000",
      });
      const corrections = await db.creditCashAdjustment.findMany({
        where: { companyId: f.company.id },
      });
      expect(corrections.map((row) => row.gstCents)).toEqual(
        partialFirst ? [2273n] : [],
      );
      const refund = await receipts.create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          kind: "refund",
          receivedOn: "2026-08-20",
          amountCents: "110000",
          method: "card",
          allocations: [{ invoiceId: id, amountCents: "110000" }],
        }),
        context: undefined,
      });
      expect(refund.status, await refund.clone().text()).toBe(201);
      expect((await read()).gst).toMatchObject({
        g1: "0",
        oneA: "0",
      });
      expect((await read()).profit.totals.profit).toBe("205000");
      if (closeBeforeCredit)
        expect((await reports(f.actor)).gst).toEqual(finalised);
      if (corrections.length)
        await expect(
          db.creditCashAdjustment.deleteMany({
            where: { companyId: f.company.id },
          }),
        ).rejects.toThrow();
    });
  it("voiding a mixed credit records a new correction without editing old allocations", async () => {
    const f = await fixture(true, "cash"),
      invoices = invoiceHandlers(() => db),
      receipts = receiptHandlers(() => db);
    const created = await invoices.create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        lines: [
          {
            description: "Taxable",
            quantity: "1",
            unitPriceCents: "100000",
            taxCode: "TAXABLE_10",
          },
          {
            description: "Outside",
            quantity: "1",
            unitPriceCents: "50000",
            taxCode: "OUT_OF_SCOPE",
          },
        ],
      }),
      context: undefined,
    });
    const id = (await created.json()).id as string;
    expect(
      (
        await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-01" }),
          context: context(id),
        })
      ).status,
    ).toBe(200);
    const credit = await invoices.credit({
      actor: f.actor,
      request: req({
        lines: [
          {
            description: "Outside credit",
            quantity: "1",
            unitPriceCents: "50000",
            taxCode: "OUT_OF_SCOPE",
          },
        ],
      }),
      context: context(id),
    });
    const creditId = (await credit.json()).id as string;
    expect(
      (
        await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-02" }),
          context: context(creditId),
        })
      ).status,
    ).toBe(200);
    const receive = async (amount: string) =>
      receipts.create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          receivedOn: sydneyToday(),
          amountCents: amount,
          method: "card",
          allocations: [{ invoiceId: id, amountCents: amount }],
        }),
        context: undefined,
      });
    const paid = await receive("110000");
    expect(paid.status).toBe(201);
    const before = await db.receiptAllocation.findFirstOrThrow({
      where: { invoiceId: id },
    });
    expect(before.gstAttributedCents).toBe(10000n);
    const voided = await invoices.void({
      actor: f.actor,
      request: req({ reason: "Synthetic credit was incorrect" }),
      context: context(creditId),
    });
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect(
      (
        await db.receiptAllocation.findUniqueOrThrow({
          where: { id: before.id },
        })
      ).gstAttributedCents,
    ).toBe(10000n);
    expect(
      (
        await db.creditCashAdjustment.findMany({ where: { invoiceId: id } })
      ).map((row) => row.gstCents),
    ).toEqual([-3125n]);
    const current = async () =>
      (
        await reportHandlers(() => db).gst({
          actor: f.actor,
          request: new Request(
            `${origin}/api/reports/gst?from=2026-07-01&to=${sydneyToday()}`,
          ),
          context: undefined,
        })
      ).json();
    expect(await current()).toMatchObject({ g1: "75625", oneA: "6875" });
    const rest = await receive("50000");
    expect(rest.status).toBe(201);
    expect((await rest.json()).allocations[0].gstAttributedCents).toBe("3125");
    expect(await current()).toMatchObject({ g1: "110000", oneA: "10000" });
  });
  it("migration corrects legacy attributed GST without rewriting allocations", async () => {
    const f = await fixture(true, "cash"),
      invoices = invoiceHandlers(() => db);
    const draft = await invoices.create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        lines: [
          {
            description: "Taxable",
            quantity: "1",
            unitPriceCents: "100000",
            taxCode: "TAXABLE_10",
          },
          {
            description: "Outside",
            quantity: "1",
            unitPriceCents: "50000",
            taxCode: "OUT_OF_SCOPE",
          },
        ],
      }),
      context: undefined,
    });
    const id = (await draft.json()).id as string;
    expect(
      (
        await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-01" }),
          context: context(id),
        })
      ).status,
    ).toBe(200);
    const credit = await invoices.credit({
      actor: f.actor,
      request: req({
        lines: [
          {
            description: "Outside credit",
            quantity: "1",
            unitPriceCents: "50000",
            taxCode: "OUT_OF_SCOPE",
          },
        ],
      }),
      context: context(id),
    });
    const creditId = (await credit.json()).id as string;
    expect(
      (
        await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-02" }),
          context: context(creditId),
        })
      ).status,
    ).toBe(200);
    // Reproduce the immutable allocation written by the pre-M4 implementation.
    await db.customerReceipt.create({
      data: {
        companyId: f.company.id,
        customerId: f.customer.id,
        receivedOn: new Date("2026-08-03"),
        amountCents: 110000n,
        method: "card",
        createdBy: f.user.id,
        idempotencyKey: randomUUID(),
        requestHash: "b".repeat(64),
        allocations: {
          create: {
            invoiceId: id,
            amountCents: 110000n,
            gstAttributedCents: 6875n,
          },
        },
      },
    });
    const migration = readFileSync(
      new URL(
        "../../packages/database/prisma/migrations/20261023210000_reporting_periods/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const statement = migration
      .slice(
        migration.indexOf("WITH credits AS ("),
        migration.indexOf("CREATE TRIGGER credit_cash_adjustments_immutable"),
      )
      .replace(
        "WHERE t.target<>t.attributed",
        "WHERE t.company_id=$1::uuid AND t.target<>t.attributed",
      );
    expect(await db.$executeRawUnsafe(statement, f.company.id)).toBe(1);
    expect(
      (
        await db.receiptAllocation.findFirstOrThrow({
          where: { invoiceId: id },
        })
      ).gstAttributedCents,
    ).toBe(6875n);
    const correction = await db.creditCashAdjustment.findFirstOrThrow({
      where: { invoiceId: id },
    });
    expect(correction.gstCents).toBe(3125n);
    expect(correction.adjustedOn.toISOString().slice(0, 10)).toBe(
      sydneyToday(),
    );
    const report = await reportHandlers(() => db).gst({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports/gst?from=2026-07-01&to=${sydneyToday()}`,
      ),
      context: undefined,
    });
    expect(await report.json()).toMatchObject({ g1: "110000", oneA: "10000" });
  });
  it("cash credit of a paid supply waits for the actual refund", async () => {
    const f = await fixture(true, "cash"),
      invoices = invoiceHandlers(() => db),
      receipts = receiptHandlers(() => db);
    const receive = async (
      kind: "receipt" | "refund",
      amount: string,
      day: string,
    ) =>
      receipts.create({
        actor: f.actor,
        request: req({
          kind,
          customerId: f.customer.id,
          receivedOn: day,
          amountCents: amount,
          method: "card",
          allocations: [{ invoiceId: f.invoice.id, amountCents: amount }],
        }),
        context: undefined,
      });
    expect((await receive("receipt", "275000", "2026-08-01")).status).toBe(201);
    const credit = await invoices.credit({
      actor: f.actor,
      request: req(),
      context: context(f.invoice.id),
    });
    expect(credit.status).toBe(201);
    const id = (await credit.json()).id as string;
    expect(
      (
        await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-08-02" }),
          context: context(id),
        })
      ).status,
    ).toBe(200);
    expect((await reports(f.actor)).gst).toMatchObject({
      g1: "275000",
      oneA: "25000",
    });
    expect((await reports(f.actor)).profit.totals).toMatchObject({
      revenue: "0",
      cost: "145000",
      profit: "-145000",
    });
    const refund = await receive("refund", "110000", "2026-08-03");
    expect(refund.status, await refund.clone().text()).toBe(201);
    expect((await refund.json()).allocations[0].gstAttributedCents).toBe(
      "-10000",
    );
    expect((await reports(f.actor)).gst).toMatchObject({
      g1: "165000",
      oneA: "15000",
    });
    expect((await reports(f.actor)).profit.totals.profit).toBe("-145000");
    expect((await receive("refund", "165000", "2026-08-04")).status).toBe(201);
    expect((await reports(f.actor)).gst).toMatchObject({ g1: "0", oneA: "0" });
  });
  it("authenticates reports, denies workers and manager GST, and hides foreign objects", async () => {
    const f = await fixture(false, "non_cash");
    const foreign = await fixture(false, "non_cash");
    const auth = createAuth({
      db,
      secret: randomBytes(32).toString("hex"),
      baseURL: origin,
      production: false,
    });
    const policy = createWithPolicy({
      auth: () => auth,
      db: () => db,
      trustedOrigins: () => [origin],
    });
    const handlers = reportHandlers(() => db);
    const profit = policy("job.profit.read", handlers.profitability),
      gst = policy("gst_report.read", handlers.gst);
    const url = `${origin}/api/reports?from=2026-07-01&to=2026-09-30`;
    expect((await profit(new Request(url), undefined)).status).toBe(401);
    for (const role of [
      "owner",
      "accountant",
      "manager",
      "employee",
      "subcontractor",
    ] as Role[]) {
      const user = await createCredentialUser(db, {
        email: `report-${randomUUID()}@example.test`,
        name: "Synthetic Role",
        password,
      });
      await db.membership.create({
        data: {
          companyId: f.company.id,
          userId: user.id,
          role,
          createdBy: f.user.id,
        },
      });
      const login = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${role.length}`,
          },
          body: JSON.stringify({ email: user.email, password }),
        }),
      );
      expect(login.status).toBe(200);
      const headers = {
        cookie: login.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; "),
      };
      expect(
        (await profit(new Request(url, { headers }), undefined)).status,
      ).toBe(["owner", "accountant", "manager"].includes(role) ? 200 : 403);
      expect((await gst(new Request(url, { headers }), undefined)).status).toBe(
        ["owner", "accountant"].includes(role) ? 200 : 403,
      );
      const close = policy(
        "gst_settings.update",
        periodHandlers(() => db).close,
      );
      const deniedOrInvalid = await close(
        new Request(`${origin}/api/reports/gst/periods`, {
          method: "POST",
          headers: { ...headers, origin, "content-type": "application/json" },
          body: JSON.stringify({
            from: "2030-01-01",
            to: "2030-03-31",
            note: "Synthetic future period",
          }),
        }),
        undefined,
      );
      expect(deniedOrInvalid.status).toBe(
        ["owner", "accountant"].includes(role) ? 400 : 403,
      );
      if (role === "owner") {
        expect(
          (
            await profit(
              new Request(url + `&jobId=${foreign.job.id}`, { headers }),
              undefined,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await profit(
              new Request(url + `&customerId=${foreign.customer.id}`, {
                headers,
              }),
              undefined,
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await profit(
              new Request(`${origin}/api/reports?from=bad&to=2026-01-01`, {
                headers,
              }),
              undefined,
            )
          ).status,
        ).toBe(400);
      }
    }
  }, 120000);
});

describe("locked GST periods and explicit amendment history", () => {
  it("only maps real locked-period SQLSTATE errors to a conflict", () => {
    expect(
      isLockedPeriodError(new Error("user text jobflow_period_locked")),
    ).toBe(false);
    expect(
      isLockedPeriodError({ code: "23505", message: "jobflow_period_locked" }),
    ).toBe(false);
    expect(
      isLockedPeriodError({
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "55000",
              originalMessage: "jobflow_period_locked",
            },
          },
        },
      }),
    ).toBe(true);
  });
  it("bounds error traversal and handles a self-referencing cause", () => {
    const cyclic: { cause?: unknown; meta?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isLockedPeriodError(cyclic)).toBe(false);
    const locked = { code: "55000", message: "jobflow_period_locked" };
    // A cycle in one branch must not hide a valid adapter error in another.
    cyclic.meta = { cause: cyclic, driverAdapterError: locked };
    expect(isLockedPeriodError(cyclic)).toBe(true);
    let deep: unknown = locked;
    for (let i = 0; i < 5; i++) deep = { cause: deep };
    expect(isLockedPeriodError(deep)).toBe(true);
    expect(isLockedPeriodError({ cause: deep })).toBe(false);
  });
  it("refuses to void an early non-cash settlement out of a finalised period", async () => {
    const f = await fixture(true, "non_cash");
    const receipts = receiptHandlers(() => db),
      payments = supplierPaymentHandlers(() => db);
    const receipt = await receipts.create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        receivedOn: "2026-06-20",
        amountCents: "1000",
        method: "card",
        allocations: [{ invoiceId: f.invoice.id, amountCents: "1000" }],
      }),
      context: undefined,
    });
    const payment = await payments.create({
      actor: f.actor,
      request: req({
        paidOn: "2026-06-20",
        amountCents: "1000",
        method: "card",
        allocations: [{ billId: f.supplier.id, amountCents: "1000" }],
      }),
      context: undefined,
    });
    expect(receipt.status).toBe(201);
    expect(payment.status).toBe(201);
    const close = await periodHandlers(() => db).close({
      actor: f.actor,
      request: req({
        from: "2026-04-01",
        to: "2026-06-30",
        note: "Synthetic deposit close",
      }),
      context: undefined,
    });
    expect(close.status).toBe(201);
    for (const [handler, response] of [
      [receipts, receipt],
      [payments, payment],
    ] as const) {
      const id = (await response.json()).id as string;
      await expect(
        handler.void({
          actor: f.actor,
          request: req({ reason: "Synthetic corrected date" }),
          context: context(id),
        }),
      ).rejects.toThrow(/jobflow_period_locked/);
    }
    expect((await reports(f.actor)).gst).toMatchObject({
      oneA: "0",
      oneB: "1500",
    });
  });
  it("reattributes non-cash GST when mistaken early settlements are voided", async () => {
    const f = await fixture(true, "non_cash");
    const receipts = receiptHandlers(() => db),
      payments = supplierPaymentHandlers(() => db);
    const receipt = await receipts.create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        receivedOn: "2026-06-20",
        amountCents: "1000",
        method: "card",
        allocations: [{ invoiceId: f.invoice.id, amountCents: "1000" }],
      }),
      context: undefined,
    });
    const payment = await payments.create({
      actor: f.actor,
      request: req({
        paidOn: "2026-06-20",
        amountCents: "1000",
        method: "card",
        allocations: [{ billId: f.supplier.id, amountCents: "1000" }],
      }),
      context: undefined,
    });
    expect(receipt.status).toBe(201);
    expect(payment.status).toBe(201);
    const read = async () =>
      (
        await reportHandlers(() => db).gst({
          actor: f.actor,
          request: new Request(
            `${origin}/api/reports/gst?from=2026-04-01&to=2026-06-30`,
          ),
          context: undefined,
        })
      ).json();
    expect(await read()).toMatchObject({ oneA: "25000", oneB: "9000" });
    for (const [handler, response] of [
      [receipts, receipt],
      [payments, payment],
    ] as const) {
      const id = (await response.json()).id as string;
      const result = await handler.void({
        actor: f.actor,
        request: req({ reason: "Synthetic corrected date" }),
        context: context(id),
      });
      expect(result.status, await result.clone().text()).toBe(200);
    }
    expect(await read()).toMatchObject({ oneA: "0", oneB: "0" });
    expect((await reports(f.actor)).gst).toMatchObject({
      oneA: "25000",
      oneB: "10500",
    });
  });
  for (const basis of ["non_cash", "cash"] as const)
    it(`records late costs on business dates and GST in the open period (${basis})`, async () => {
      const f = await fixture(true, basis);
      const closed = await periodHandlers(() => db).close({
        actor: f.actor,
        request: req({
          from: "2026-07-01",
          to: "2026-09-30",
          note: "Synthetic close",
        }),
        context: undefined,
      });
      expect(closed.status).toBe(201);
      const snapshot = (await reports(f.actor)).gst;
      const bill = await billHandlers(() => db).create({
        actor: f.actor,
        request: req({
          jobId: f.job.id,
          supplierName: "Synthetic late supplier",
          supplierGstRegistered: true,
          supplierAbn: syntheticAbn("545454547"),
          issuedOn: "2026-08-15",
          lines: [
            {
              description: "Late work",
              taxCode: "TAXABLE_10",
              exclusiveCents: "10000",
              gstCents: "1000",
            },
          ],
          documentId: await f.doc(),
          evidenceVerified: true,
        }),
        context: undefined,
      });
      expect(bill.status, await bill.clone().text()).toBe(201);
      const billId = (await bill.json()).id as string;
      if (basis === "cash") {
        const payment = await supplierPaymentHandlers(() => db).create({
          actor: f.actor,
          request: req({
            paidOn: "2026-08-20",
            amountCents: "11000",
            method: "card",
            allocations: [{ billId, amountCents: "11000" }],
          }),
          context: undefined,
        });
        expect(payment.status, await payment.clone().text()).toBe(201);
      }
      // A late approved labour snapshot has cost but no GST. The source trigger
      // must allow its true work date even when that quarter is finalised.
      const labour = await db.timesheet.findFirstOrThrow({
        where: { companyId: f.company.id },
      });
      await db.timesheet.create({
        data: {
          companyId: f.company.id,
          employeeId: labour.employeeId,
          jobId: f.job.id,
          workDate: new Date("2026-08-17"),
          minutes: 60,
          status: "approved",
          rateId: labour.rateId,
          hourlyCostCents: labour.hourlyCostCents,
          costCents: 6000n,
          submittedBy: f.user.id,
          decidedBy: f.user.id,
          decidedAt: new Date(),
        },
      });
      const handler = expenseHandlers(() => db);
      const expense = await handler.create({
        actor: f.actor,
        request: req({
          jobId: f.job.id,
          category: "materials",
          description: "Late materials",
          purchasedOn: "2026-08-16",
          priceEntry: "exclusive",
          amountCents: "2000",
          taxCode: "TAXABLE_10",
          receiptDocumentId: await f.doc(),
          settlement: "paid_at_purchase",
          paymentMethod: "card",
        }),
        context: undefined,
      });
      expect(expense.status, await expense.clone().text()).toBe(201);
      const id = (await expense.json()).id as string;
      const approval = await handler.decide({
        actor: f.actor,
        request: req({ decision: "approve", evidenceVerified: true }),
        context: context(id),
      });
      expect(approval.status, await approval.clone().text()).toBe(200);
      const report = await reports(f.actor);
      expect(report.profit.totals).toMatchObject({
        cost: "163000",
        profit: "87000",
      });
      expect(report.gst).toEqual(snapshot);
      if (basis === "cash")
        expect(report.profit.totals.paidInclusive).toBe("39700");
      const current = await reportHandlers(() => db).gst({
        actor: f.actor,
        request: new Request(
          `${origin}/api/reports/gst?from=2026-10-01&to=${sydneyToday()}`,
        ),
        context: undefined,
      });
      expect(await current.json()).toMatchObject({ oneB: "1200" });
      const rows = await db.$queryRaw<
        { effective_on: Date }[]
      >`SELECT effective_on FROM gst_source_postings WHERE company_id=${f.company.id}::uuid AND source_id=${id}::uuid`;
      expect(
        rows.some(
          (r) => r.effective_on.toISOString().slice(0, 10) === sydneyToday(),
        ),
      ).toBe(true);
      await expect(
        db.$executeRaw`DELETE FROM gst_source_postings WHERE company_id=${f.company.id}::uuid`,
      ).rejects.toThrow();
    });
  it("freezes source dates/settings and records an immutable amended revision", async () => {
    const f = await fixture(true, "non_cash");
    const periods = periodHandlers(() => db);
    const closed = await periods.close({
      actor: f.actor,
      request: req({
        from: "2026-07-01",
        to: "2026-09-30",
        note: "Synthetic accountant finalisation",
      }),
      context: undefined,
    });
    expect(closed.status, await closed.clone().text()).toBe(201);
    const period = (await closed.json()) as {
      id: string;
      revisions: { report: { oneA: string; oneB: string; netGst: string } }[];
    };
    expect(period.revisions[0]!.report).toMatchObject({
      oneA: "25000",
      oneB: "10500",
      netGst: "14500",
    });
    const createReceipt = () =>
      receiptHandlers(() => db).create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          receivedOn: "2026-07-16",
          amountCents: "100",
          method: "card",
          allocations: [{ invoiceId: f.invoice.id, amountCents: "100" }],
        }),
        context: undefined,
      });
    expect((await createReceipt()).status).toBe(201);
    await expect(
      receiptHandlers(() => db).create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          receivedOn: "2026-06-01",
          amountCents: "100",
          method: "card",
          allocations: [{ invoiceId: f.invoice.id, amountCents: "100" }],
        }),
        context: undefined,
      }),
    ).rejects.toThrow(/jobflow_period_locked/);

    const auth = createAuth({
      db,
      secret: randomBytes(32).toString("hex"),
      baseURL: origin,
      production: false,
    });
    const policy = createWithPolicy({
      auth: () => auth,
      db: () => db,
      trustedOrigins: () => [origin],
    });
    const login = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: f.user.email, password }),
      }),
    );
    expect(login.status).toBe(200);
    const blockedRequest = req({
      customerId: f.customer.id,
      receivedOn: "2026-06-01",
      amountCents: "100",
      method: "card",
      allocations: [{ invoiceId: f.invoice.id, amountCents: "100" }],
    });
    blockedRequest.headers.set(
      "cookie",
      login.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    );
    expect(
      (
        await policy("payment.write", receiptHandlers(() => db).create)(
          blockedRequest,
          undefined,
        )
      ).status,
    ).toBe(409);

    expect(
      await db.customerReceipt.count({ where: { companyId: f.company.id } }),
    ).toBe(1);
    await expect(
      db.companyGstRegistration.updateMany({
        where: { companyId: f.company.id },
        data: { basis: "cash" },
      }),
    ).rejects.toThrow(/jobflow_period_locked/);
    // Non-overlapping registration changes remain possible.
    const registration = await db.companyGstRegistration.findFirstOrThrow({
      where: { companyId: f.company.id },
    });
    await db.companyGstRegistration.update({
      where: { id: registration.id },
      data: { endsOn: new Date("2026-12-31") },
    });
    const normal = await periods.adjust({
      actor: f.actor,
      request: req({
        effectiveOn: "2026-07-16",
        oneA: "-100",
        reason: "Synthetic correction",
      }),
      context: undefined,
    });
    expect(normal.status).toBe(409);
    const amendmentRequest = req({
      effectiveOn: "2026-07-16",
      oneA: "-100",
      reason: "Synthetic explicit amended GST",
    });
    const retryRequest = amendmentRequest.clone();
    const amended = await periods.amend({
      actor: f.actor,
      request: amendmentRequest,
      context: context(period.id),
    });
    expect(amended.status, await amended.clone().text()).toBe(201);
    const replay = await periods.amend({
      actor: f.actor,
      request: retryRequest,
      context: context(period.id),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).replayed).toBe(true);
    const history = await db.gstReportRevision.findMany({
      where: { periodId: period.id },
      orderBy: { revision: "asc" },
    });
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    expect(history[0]!.report).toMatchObject({
      oneA: "25000",
      netGst: "14500",
    });
    expect(history[1]!.report).toMatchObject({
      oneA: "24900",
      netGst: "14400",
    });
    expect((await reports(f.actor)).profit.totals.profit).toBe("105000");
    await expect(
      db.gstReportRevision.deleteMany({ where: { periodId: period.id } }),
    ).rejects.toThrow();
    await expect(
      db.gstManualAdjustment.deleteMany({ where: { periodId: period.id } }),
    ).rejects.toThrow();
    const foreign = { ...f.actor, companyId: randomUUID() };
    await expect(
      periods.amend({
        actor: foreign,
        request: req({
          effectiveOn: "2026-07-16",
          oneA: "-1",
          reason: "Synthetic forbidden",
        }),
        context: context(period.id),
      }),
    ).rejects.toThrow();
  }, 120000);
  it("waits for an in-flight writer before computing the final snapshot", async () => {
    const f = await fixture(true, "cash");
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const unblock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = db.$transaction(
      async (tx) => {
        const pid = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const receipt = await tx.customerReceipt.create({
          data: {
            companyId: f.company.id,
            customerId: f.customer.id,
            receivedOn: new Date("2026-07-16"),
            amountCents: 100n,
            method: "card",
            idempotencyKey: randomUUID(),
            requestHash: "b".repeat(64),
            createdBy: f.actor.userId,
          },
        });
        await tx.receiptAllocation.create({
          data: {
            companyId: f.company.id,
            receiptId: receipt.id,
            invoiceId: f.invoice.id,
            amountCents: 100n,
            gstAttributedCents: 9n,
          },
        });
        locked();
        await unblock;
        return pid[0]!.pid;
      },
      { timeout: 10000 },
    );
    await barrier;
    let finished = false;
    const close = periodHandlers(() => db)
      .close({
        actor: f.actor,
        request: req({
          from: "2026-07-01",
          to: "2026-09-30",
          note: "Synthetic concurrent close",
        }),
        context: undefined,
      })
      .then((result) => {
        finished = true;
        return result;
      });
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<
          { blocked: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(%') AS blocked`;
        if (rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release();
    }
    await writer;
    const result = await close;
    expect(result.status, await result.clone().text()).toBe(201);
    const body = (await result.json()) as {
      revisions: { report: { oneA: string } }[];
    };
    expect(body.revisions[0]!.report.oneA).toBe("9");
  }, 120000);
});

describe("cash reporting source regressions", () => {
  it("attributes mixed out-of-scope G1 cumulatively and filters by job", async () => {
    const f = await fixture(true, "cash");
    const job = await db.job.create({
      data: {
        companyId: f.company.id,
        customerId: f.customer.id,
        number: 2,
        reference: "JOB-0002",
        title: "Synthetic mixed supplies",
        status: "completed",
        createdBy: f.user.id,
      },
    });
    const invoices = invoiceHandlers(() => db);
    const created = await invoices.create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        jobId: job.id,
        lines: [
          {
            description: "Taxable",
            quantity: "1",
            unitPriceCents: "1000",
            taxCode: "TAXABLE_10",
          },
          {
            description: "Out of scope",
            quantity: "1",
            unitPriceCents: "1100",
            taxCode: "OUT_OF_SCOPE",
          },
        ],
      }),
      context: undefined,
    });
    expect(created.status).toBe(201);
    const invoice = (await created.json()) as { id: string };
    expect(
      (
        await invoices.issue({
          actor: f.actor,
          request: req({ issueDate: "2026-07-16" }),
          context: context(invoice.id),
        })
      ).status,
    ).toBe(200);
    const received = await receiptHandlers(() => db).create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        receivedOn: "2026-07-16",
        amountCents: "1100",
        method: "card",
        allocations: [{ invoiceId: invoice.id, amountCents: "1100" }],
      }),
      context: undefined,
    });
    expect(received.status).toBe(201);
    const response = await reportHandlers(() => db).gst({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports?from=2026-07-01&to=2026-09-30&jobId=${job.id}`,
      ),
      context: undefined,
    });
    expect(await response.json()).toMatchObject({
      g1: "550",
      oneA: "50",
      oneB: "0",
    });
  }, 120000);
  it("records expense refunds as cash reversals without duplicating the cost", async () => {
    const f = await fixture(true, "cash");
    const reversed = await expenseHandlers(() => db).reverse({
      actor: f.actor,
      request: req({
        note: "Synthetic purchase returned",
        settlement: "refund",
        refundedOn: sydneyToday(),
        paymentMethod: "card",
      }),
      context: context(f.expenseIds[0]!),
    });
    expect(reversed.status, await reversed.clone().text()).toBe(201);
    const request = new Request(
        `${origin}/api/reports?from=2026-07-01&to=${sydneyToday()}`,
      ),
      handler = reportHandlers(() => db);
    const profit = await (
      await handler.profitability({
        actor: f.actor,
        request,
        context: undefined,
      })
    ).json();
    expect(profit.totals).toMatchObject({
      profit: "120000",
      cost: "130000",
      paidInclusive: "10000",
    });
    const gst = await (
      await handler.gst({ actor: f.actor, request, context: undefined })
    ).json();
    expect(gst.oneB).toBe("0");
  }, 120000);
});

// P1: current balances alone do not prove that a dated ledger is valid.
describe("chronological settlement safety and legacy report isolation", () => {
  for (const basis of ["cash", "non_cash"] as const) {
    it(`rejects backdated receipts/refunds and unsafe voids (${basis})`, async () => {
      const f = await fixture(true, basis),
        handler = receiptHandlers(() => db);
      const settle = async (
        kind: "receipt" | "refund",
        date: string,
        amount = "275000",
      ) =>
        handler.create({
          actor: f.actor,
          request: req({
            customerId: f.customer.id,
            kind,
            receivedOn: date,
            amountCents: amount,
            method: "card",
            allocations: [{ invoiceId: f.invoice.id, amountCents: amount }],
          }),
          context: undefined,
        });
      expect((await settle("receipt", "2026-08-01")).status).toBe(201);
      const refund = await settle("refund", "2026-09-01");
      expect(refund.status).toBe(201);
      const refundId = (await refund.json()).id as string;
      const replacement = await settle("receipt", "2026-07-20");
      expect(replacement.status, await replacement.clone().text()).toBe(400);
      expect(
        await db.customerReceipt.count({ where: { companyId: f.company.id } }),
      ).toBe(2);
      expect((await settle("receipt", "2026-09-02", "100")).status).toBe(201);
      expect((await settle("refund", "2026-07-19", "100")).status).toBe(400);
      const voided = await handler.void({
        actor: f.actor,
        request: req({ reason: "Synthetic unsafe void" }),
        context: context(refundId),
      });
      expect(voided.status).toBe(400);
      expect(
        (
          await db.customerReceipt.findUniqueOrThrow({
            where: { id: refundId },
          })
        ).voidedAt,
      ).toBeNull();
    });
    it(`rejects backdated supplier replacement payments (${basis})`, async () => {
      const f = await fixture(true, basis),
        handler = supplierPaymentHandlers(() => db);
      const pay = (date: string) =>
        handler.create({
          actor: f.actor,
          request: req({
            paidOn: date,
            amountCents: "99000",
            method: "card",
            allocations: [{ billId: f.supplier.id, amountCents: "99000" }],
          }),
          context: undefined,
        });
      const paid = await pay("2026-08-01");
      expect(paid.status).toBe(201);
      const id = (await paid.json()).id as string;
      expect(
        (
          await handler.void({
            actor: f.actor,
            request: req({ reason: "Synthetic bounced payment" }),
            context: context(id),
          })
        ).status,
      ).toBe(200);
      expect((await pay("2026-07-20")).status).toBe(400);
      expect(
        await db.supplierPayment.count({ where: { companyId: f.company.id } }),
      ).toBe(1);
      expect((await pay(sydneyToday())).status).toBe(201);
    });
    it(`warns for a legacy invoice while other invoices and profit remain available (${basis})`, async () => {
      const f = await fixture(true, basis);
      for (const [kind, date] of [
        ["receipt", "2026-08-01"],
        ["refund", "2026-09-01"],
        ["receipt", "2026-07-20"],
      ] as const) {
        await db.$transaction(async (tx) => {
          const receipt = await tx.customerReceipt.create({
            data: {
              companyId: f.company.id,
              customerId: f.customer.id,
              kind,
              receivedOn: new Date(date),
              amountCents: 275000n,
              method: "card",
              createdBy: f.user.id,
              idempotencyKey: randomUUID(),
              requestHash: "c".repeat(64),
            },
          });
          await tx.receiptAllocation.create({
            data: {
              companyId: f.company.id,
              receiptId: receipt.id,
              invoiceId: f.invoice.id,
              amountCents: 275000n,
              gstAttributedCents: kind === "refund" ? -25000n : 25000n,
            },
          });
        });
      }
      const invoices = invoiceHandlers(() => db),
        receipts = receiptHandlers(() => db);
      const created = await invoices.create({
        actor: f.actor,
        request: req({
          customerId: f.customer.id,
          jobId: f.job.id,
          lines: [
            {
              description: "Unaffected synthetic supply",
              quantity: "1",
              unitPriceCents: "1000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        context: undefined,
      });
      expect(created.status).toBe(201);
      const healthyId = (await created.json()).id as string;
      expect(
        (
          await invoices.issue({
            actor: f.actor,
            request: req({ issueDate: "2026-08-15" }),
            context: context(healthyId),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await receipts.create({
            actor: f.actor,
            request: req({
              customerId: f.customer.id,
              receivedOn: "2026-09-15",
              amountCents: "1100",
              method: "card",
              allocations: [{ invoiceId: healthyId, amountCents: "1100" }],
            }),
            context: undefined,
          })
        ).status,
      ).toBe(201);
      const report = await reports(f.actor);
      expect(report.profit.totals).toMatchObject({
        revenue: "251000",
        cost: "145000",
        profit: "106000",
        receivedInclusive: "276100",
      });
      for (const result of [report.profit, report.gst])
        expect(result.warnings).toEqual([
          expect.objectContaining({
            code: "INVALID_SETTLEMENT_HISTORY",
            sourceId: f.invoice.id,
            sourceType: "invoice",
            omittedGst: basis === "cash",
          }),
        ]);
      expect(report.gst).toMatchObject({
        oneA: basis === "cash" ? "100" : "25100",
        incomplete: basis === "cash",
      });
      expect(
        report.gst.events.some(
          (event: { sourceId: string; amount: string }) =>
            event.sourceId !== f.invoice.id && event.amount === "100",
        ),
      ).toBe(true);
      const close = await periodHandlers(() => db).close({
        actor: f.actor,
        request: req({
          from: "2026-07-01",
          to: "2026-09-30",
          note: "Must not freeze incomplete sources",
        }),
        context: undefined,
      });
      expect(close.status).toBe(409);
      expect((await close.json()).warnings[0].sourceId).toBe(f.invoice.id);
      // The accountant's GST exports refuse the same incomplete draft.
      for (const name of ["gst-summary", "gst-lines"]) {
        const exported = await exportHandlers(() => db).run({
          actor: f.actor,
          request: new Request(
            `${origin}/api/exports/${name}?from=2026-07-01&to=2026-09-30`,
          ),
          context: { params: Promise.resolve({ name }) },
        });
        expect(exported.status, name).toBe(basis === "cash" ? 409 : 200);
        if (basis === "cash")
          expect((await exported.json()).warnings[0].sourceId).toBe(
            f.invoice.id,
          );
      }
      expect(
        await db.gstPeriod.count({ where: { companyId: f.company.id } }),
      ).toBe(0);
    });
  }
});

it("backfills GST source postings when deploying over legacy financial rows", async () => {
  const f = await fixture(true, "cash");
  const receipt = await receiptHandlers(() => db).create({
    actor: f.actor,
    request: req({
      customerId: f.customer.id,
      receivedOn: "2026-08-01",
      amountCents: "100",
      method: "card",
      allocations: [{ invoiceId: f.invoice.id, amountCents: "100" }],
    }),
    context: undefined,
  });
  expect(receipt.status).toBe(201);
  const receiptId = (await receipt.json()).id as string;
  const { Client } = createRequire(
    new URL("../../packages/database/package.json", import.meta.url),
  )("pg");
  const connection = new Client({ connectionString: database.url });
  await connection.connect();
  try {
    // Down/up leaves immutable source documents in place, simulating first
    // deployment of the reporting migration against a pre-reporting database.
    await connection.query(
      readFileSync(
        new URL(
          "../../packages/database/prisma/rollbacks/20261023210000_reporting_periods.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await connection.query(
      readFileSync(
        new URL(
          "../../packages/database/prisma/migrations/20261023210000_reporting_periods/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  } finally {
    await connection.end();
  }
  const rows = await db.gstSourcePosting.findMany({
    where: { companyId: f.company.id },
  });
  for (const id of [f.invoice.id, f.supplier.id, receiptId, ...f.expenseIds])
    expect(rows.some((row) => row.sourceId === id)).toBe(true);
  expect(
    rows.every((row) => row.originalOn.getTime() === row.effectiveOn.getTime()),
  ).toBe(true);
});

describe("supplier credits in reports (#140)", () => {
  const credit = (actor: Actor, billId: string, taxCode = "TAXABLE_10") =>
    supplierCreditHandlers(() => db).create({
      actor,
      request: req({
        supplierReference: `CN-${randomUUID().slice(0, 8)}`,
        issuedOn: "2026-07-20",
        receivedOn: "2026-07-20",
        lines: [
          {
            description: "Synthetic price adjustment",
            taxCode,
            exclusiveCents: "10000",
            gstCents: taxCode === "TAXABLE_10" ? "1000" : "0",
          },
        ],
      }),
      context: context(billId),
    });
  const pay = (actor: Actor, billId: string, paidOn: string, cents: string) =>
    supplierPaymentHandlers(() => db).create({
      actor,
      request: req({
        paidOn,
        amountCents: cents,
        method: "bank_transfer",
        allocations: [{ billId, amountCents: cents }],
      }),
      context: undefined,
    });
  const on = async (actor: Actor, day: string) => {
    const handler = reportHandlers(() => db),
      request = new Request(`${origin}/api/reports?from=${day}&to=${day}`);
    return {
      gst: await (
        await handler.gst({ actor, request, context: undefined })
      ).json(),
      profit: await (
        await handler.profitability({ actor, request, context: undefined })
      ).json(),
    };
  };
  const voidCredit = (actor: Actor, id: string) =>
    supplierCreditHandlers(() => db).void({
      actor,
      request: req({ reason: "Synthetic duplicate" }),
      context: context(id),
    });

  it("reports a cash-basis correction on a paid bill, and its void today", async () => {
    const f = await fixture(true, "cash");
    const paid = await pay(f.actor, f.supplier.id, "2026-07-18", "49500");
    expect(paid.status, await paid.clone().text()).toBe(201);
    expect((await reports(f.actor)).gst).toMatchObject({ oneB: "6000" });
    // A GST-free credit raises the paid share's GST: round(49500 × 9000 /
    // 89000) = 5006, so +506 on 20 July ($75 or less: no note needed).
    const created = await credit(f.actor, f.supplier.id, "GST_FREE");
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(
      await db.supplierCreditGstAdjustment.findMany({
        where: { creditId: id },
        select: { event: true, creditableGstCents: true, adjustedOn: true },
      }),
    ).toEqual([
      {
        event: "recorded",
        creditableGstCents: 506n,
        adjustedOn: new Date("2026-07-20T00:00:00Z"),
      },
    ]);
    expect((await reports(f.actor)).gst).toMatchObject({ oneB: "6506" });
    // Cash basis: no payment may now be dated before the credit (#54 rule).
    const early = await pay(f.actor, f.supplier.id, "2026-07-19", "1000");
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({
      fields: { paidOn: expect.stringMatching(/supplier credit/) },
    });
    const voided = await voidCredit(f.actor, id);
    expect(voided.status, await voided.clone().text()).toBe(200);
    expect((await reports(f.actor)).gst).toMatchObject({ oneB: "6506" });
    const today = await on(f.actor, sydneyToday());
    expect(today.gst).toMatchObject({ oneB: "-506" });
    // The job cost comes back on the void day too.
    expect(today.profit.totals).toMatchObject({ cost: "10000" });
  });

  it("reverses a credit voided after its period was finalised in the open period", async () => {
    const f = await fixture(true, "non_cash");
    const created = await credit(f.actor, f.supplier.id);
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const close = await periodHandlers(() => db).close({
      actor: f.actor,
      request: req({
        from: "2026-07-01",
        to: "2026-09-30",
        note: "Synthetic supplier credit void boundary",
      }),
      context: undefined,
    });
    expect(close.status, await close.clone().text()).toBe(201);
    const finalised = (await reports(f.actor)).gst as Record<string, unknown>;
    expect(finalised).toMatchObject({ oneB: "9500" });
    expect((await voidCredit(f.actor, id)).status).toBe(200);
    expect((await reports(f.actor)).gst).toMatchObject({
      oneA: finalised.oneA,
      oneB: "9500",
    });
    expect((await on(f.actor, sydneyToday())).gst).toMatchObject({
      oneB: "1000",
    });
  });

  it("never stores a credit that was voided before it was recorded", async () => {
    const f = await fixture(true, "non_cash");
    const created = await credit(f.actor, f.supplier.id);
    const row = await db.supplierCredit.findUniqueOrThrow({
      where: { id: ((await created.json()) as { id: string }).id },
    });
    await expect(
      db.supplierCredit.create({
        data: {
          ...row,
          id: randomUUID(),
          supplierReference: null,
          voidedAt: new Date(),
          voidedBy: f.user.id,
          voidReason: "Synthetic",
        },
      }),
    ).rejects.toThrow(/recorded before it is voided/);
  });

  for (const basis of ["non_cash", "cash"] as const)
    it(`lowers job cost and (${basis}) the purchases GST on the date received`, async () => {
      const f = await fixture(true, basis);
      const created = await credit(f.actor, f.supplier.id);
      expect(created.status, await created.clone().text()).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const after = await reports(f.actor);
      expect(after.profit.totals).toMatchObject({
        revenue: "250000",
        cost: "135000",
        profit: "115000",
      });
      // Unpaid on the cash basis: nothing was claimed, so nothing comes back.
      expect(after.gst).toMatchObject({
        oneB: basis === "cash" ? "1500" : "9500",
      });
      const voided = await supplierCreditHandlers(() => db).void({
        actor: f.actor,
        request: req({ reason: "Synthetic duplicate" }),
        context: context(id),
      });
      expect(voided.status, await voided.clone().text()).toBe(200);
      // Reversed on the void day (today), outside July–September.
      const today = await reportHandlers(() => db).gst({
        actor: f.actor,
        request: new Request(
          `${origin}/api/reports?from=${sydneyToday()}&to=${sydneyToday()}`,
        ),
        context: undefined,
      });
      expect(await today.json()).toMatchObject({
        oneB: basis === "cash" ? "0" : "1000",
      });
      expect((await reports(f.actor)).profit.totals).toMatchObject({
        cost: "135000",
      });
    });

  it("posts a credit dated in a finalised period to the open period", async () => {
    const f = await fixture(true, "non_cash");
    const close = await periodHandlers(() => db).close({
      actor: f.actor,
      request: req({
        from: "2026-07-01",
        to: "2026-09-30",
        note: "Synthetic supplier credit boundary",
      }),
      context: undefined,
    });
    expect(close.status, await close.clone().text()).toBe(201);
    const finalised = (await reports(f.actor)).gst;
    const created = await credit(f.actor, f.supplier.id);
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const posting = await db.gstSourcePosting.findFirstOrThrow({
      where: { companyId: f.company.id, sourceId: id },
    });
    expect(posting.originalOn.toISOString().slice(0, 10)).toBe("2026-07-20");
    expect(posting.effectiveOn.toISOString().slice(0, 10)).toBe(sydneyToday());
    expect((await reports(f.actor)).gst).toMatchObject({
      oneA: (finalised as { oneA: string }).oneA,
      oneB: (finalised as { oneB: string }).oneB,
    });
    const current = await reportHandlers(() => db).gst({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports?from=${sydneyToday()}&to=${sydneyToday()}`,
      ),
      context: undefined,
    });
    expect(await current.json()).toMatchObject({ oneB: "-1000" });
  });
});

describe("on-account expenses paid later in reports (#141)", () => {
  for (const basis of ["cash", "non_cash"] as const)
    it(`attributes the payment's GST on the payment date (${basis})`, async () => {
      const f = await fixture(true, basis);
      const expenses = expenseHandlers(() => db);
      const submitted = await expenses.create({
        actor: f.actor,
        request: req({
          jobId: f.job.id,
          category: "materials",
          description: "Synthetic on-account purchase",
          supplierName: "Synthetic Supplies",
          purchasedOn: "2026-07-15",
          priceEntry: "exclusive",
          amountCents: "15000",
          taxCode: "TAXABLE_10",
          receiptDocumentId: await f.doc(),
          settlement: "on_account",
        }),
        context: undefined,
      });
      expect(submitted.status, await submitted.clone().text()).toBe(201);
      const { id } = (await submitted.json()) as { id: string };
      const decided = await expenses.decide({
        actor: f.actor,
        request: req({ decision: "approve", evidenceVerified: true }),
        context: context(id),
      });
      expect(decided.status, await decided.clone().text()).toBe(200);
      const before = await reports(f.actor);
      expect(before.profit.totals).toMatchObject({ cost: "160000" });
      expect(before.gst).toMatchObject({
        oneB: basis === "cash" ? "1500" : "12000",
      });
      const paid = await supplierPaymentHandlers(() => db).create({
        actor: f.actor,
        request: req({
          paidOn: "2026-07-20",
          amountCents: "11000",
          method: "bank_transfer",
          allocations: [{ expenseId: id, amountCents: "11000" }],
        }),
        context: undefined,
      });
      expect(paid.status, await paid.clone().text()).toBe(201);
      const payment = (await paid.json()) as { id: string };
      const after = await reports(f.actor);
      // round(11000 × 1500 / 16500) = 1000 on the cash basis.
      expect(after.gst).toMatchObject({
        oneB: basis === "cash" ? "2500" : "12000",
      });
      expect(after.profit.totals).toMatchObject({
        cost: "160000",
        paidInclusive: (
          BigInt(before.profit.totals.paidInclusive) + 11000n
        ).toString(),
      });
      const voided = await supplierPaymentHandlers(() => db).void({
        actor: f.actor,
        request: req({ reason: "Synthetic bank error" }),
        context: context(payment.id),
      });
      expect(voided.status, await voided.clone().text()).toBe(200);
      expect((await reports(f.actor)).gst).toMatchObject({
        oneB: basis === "cash" ? "2500" : "12000",
      });
      const today = await reportHandlers(() => db).gst({
        actor: f.actor,
        request: new Request(
          `${origin}/api/reports?from=${sydneyToday()}&to=${sydneyToday()}`,
        ),
        context: undefined,
      });
      expect(await today.json()).toMatchObject({
        oneB: basis === "cash" ? "-1000" : "0",
      });
      const posting = await db.gstSourcePosting.findMany({
        where: { companyId: f.company.id, sourceId: payment.id },
      });
      expect(posting.length).toBeGreaterThan(0);
    });

  it("posts a payment dated in a finalised period to the open period (cash)", async () => {
    const f = await fixture(true, "cash");
    const expenses = expenseHandlers(() => db);
    const submitted = await expenses.create({
      actor: f.actor,
      request: req({
        jobId: f.job.id,
        category: "materials",
        description: "Synthetic on-account purchase",
        supplierName: "Synthetic Supplies",
        purchasedOn: "2026-07-15",
        priceEntry: "exclusive",
        amountCents: "15000",
        taxCode: "TAXABLE_10",
        receiptDocumentId: await f.doc(),
        settlement: "on_account",
      }),
      context: undefined,
    });
    const { id } = (await submitted.json()) as { id: string };
    expect(
      (
        await expenses.decide({
          actor: f.actor,
          request: req({ decision: "approve", evidenceVerified: true }),
          context: context(id),
        })
      ).status,
    ).toBe(200);
    const close = await periodHandlers(() => db).close({
      actor: f.actor,
      request: req({ from: "2026-07-01", to: "2026-09-30", note: "Synthetic" }),
      context: undefined,
    });
    expect(close.status, await close.clone().text()).toBe(201);
    const finalised = (await reports(f.actor)).gst as { oneB: string };
    const paid = await supplierPaymentHandlers(() => db).create({
      actor: f.actor,
      request: req({
        paidOn: "2026-07-20",
        amountCents: "16500",
        method: "bank_transfer",
        allocations: [{ expenseId: id, amountCents: "16500" }],
      }),
      context: undefined,
    });
    expect(paid.status, await paid.clone().text()).toBe(201);
    const payment = (await paid.json()) as { id: string };
    const posting = await db.gstSourcePosting.findFirstOrThrow({
      where: { companyId: f.company.id, sourceId: payment.id },
    });
    expect(posting.effectiveOn.toISOString().slice(0, 10)).toBe(sydneyToday());
    expect((await reports(f.actor)).gst).toMatchObject({
      oneB: finalised.oneB,
    });
    const today = await reportHandlers(() => db).gst({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports?from=${sydneyToday()}&to=${sydneyToday()}`,
      ),
      context: undefined,
    });
    expect(await today.json()).toMatchObject({ oneB: "1500" });
  });
});

// #157: bounded source reads must not change any report. Runs last, over
// every company the tests above built (both GST bases, unregistered,
// credits, voids, finalised periods, late postings, expense chains).
describe("bounded report sources (#157)", () => {
  const windows = (): { from: string; to: string }[] => {
    const out: { from: string; to: string }[] = [];
    for (const [from, to] of [
      ["2025-07-01", "2025-09-30"],
      ["2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-06-30"],
      ["2026-07-01", "2026-09-30"],
      ["2026-10-01", "2026-12-31"],
      ["2026-07-15", "2026-07-15"],
      ["2026-07-16", "2026-07-31"],
      ["2026-07-20", "2026-08-31"],
      ["2026-08-01", "2099-12-31"],
      ["2000-01-01", "2099-12-31"],
    ] as const)
      out.push({ from, to });
    const today = sydneyToday();
    out.push({ from: today, to: today }, { from: today, to: "2099-12-31" });
    return out;
  };
  const stable = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );

  it("builds documents whose only recent activity is a void, a late posting or a correction", async () => {
    for (const basis of ["non_cash", "cash"] as const) {
      // Old invoice and bill voided today; an expense reversed today.
      const a = await fixture(true, basis);
      expect(
        (
          await invoiceHandlers(() => db).void({
            actor: a.actor,
            request: req({ reason: "Synthetic void today" }),
            context: context(a.invoice.id),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await billHandlers(() => db).void({
            actor: a.actor,
            request: req({ reason: "Synthetic void today" }),
            context: context(a.supplier.id),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await expenseHandlers(() => db).reverse({
            actor: a.actor,
            request: req({ note: "Synthetic reversal today" }),
            context: context(a.expenseIds[0]!),
          })
        ).status,
      ).toBe(201);
      // Settlements dated in July and voided today.
      const b = await fixture(true, basis);
      const receipt = await receiptHandlers(() => db).create({
        actor: b.actor,
        request: req({
          customerId: b.customer.id,
          receivedOn: "2026-07-20",
          amountCents: "100000",
          method: "bank_transfer",
          allocations: [{ invoiceId: b.invoice.id, amountCents: "100000" }],
        }),
        context: undefined,
      });
      expect(receipt.status, await receipt.clone().text()).toBe(201);
      const payment = await supplierPaymentHandlers(() => db).create({
        actor: b.actor,
        request: req({
          paidOn: "2026-07-20",
          amountCents: "40000",
          method: "bank_transfer",
          allocations: [{ billId: b.supplier.id, amountCents: "40000" }],
        }),
        context: undefined,
      });
      expect(payment.status, await payment.clone().text()).toBe(201);
      for (const [handler, response] of [
        [receiptHandlers(() => db), receipt],
        [supplierPaymentHandlers(() => db), payment],
      ] as const)
        expect(
          (
            await handler.void({
              actor: b.actor,
              request: req({ reason: "Synthetic void today" }),
              context: context(((await response.json()) as { id: string }).id),
            })
          ).status,
        ).toBe(200);
      // A receipt entered after its quarter was finalised posts today.
      const c = await fixture(true, basis);
      expect(
        (
          await periodHandlers(() => db).close({
            actor: c.actor,
            request: req({
              from: "2026-07-01",
              to: "2026-09-30",
              note: "Synthetic bounded-read boundary",
            }),
            context: undefined,
          })
        ).status,
      ).toBe(201);
      const late = await receiptHandlers(() => db).create({
        actor: c.actor,
        request: req({
          customerId: c.customer.id,
          receivedOn: "2026-07-25",
          amountCents: "50000",
          method: "bank_transfer",
          allocations: [{ invoiceId: c.invoice.id, amountCents: "50000" }],
        }),
        context: undefined,
      });
      expect(late.status, await late.clone().text()).toBe(201);
    }
  });

  it("every report from a bounded read equals the full read", async () => {
    const { financialEvents } =
      await import("../../apps/web/src/server/reports/events");
    const { draftGstReport, profitabilityReport } =
      await import("../../packages/domain/src/index");
    const companies = await db.company.findMany({ select: { id: true } });
    let compared = 0;
    for (const { id } of companies) {
      const full = await db.$transaction((tx) => financialEvents(tx, id), {
        isolationLevel: "RepeatableRead",
      });
      for (const range of windows()) {
        const bounded = await db.$transaction(
          (tx) => financialEvents(tx, id, { since: range.from }),
          { isolationLevel: "RepeatableRead" },
        );
        expect(
          stable(draftGstReport(bounded.events, range)),
          `${id} gst ${range.from}..${range.to}`,
        ).toBe(stable(draftGstReport(full.events, range)));
        expect(
          stable(profitabilityReport(bounded.events, range)),
          `${id} profit ${range.from}..${range.to}`,
        ).toBe(stable(profitabilityReport(full.events, range)));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  }, 300_000);

  it("pages drill-down events without changing any total", async () => {
    const f = await fixture(true, "non_cash");
    const handler = reportHandlers(() => db);
    const get = async (query: string) =>
      (
        await handler.profitability({
          actor: f.actor,
          request: new Request(
            `${origin}/api/reports?from=2026-07-01&to=2026-09-30${query}`,
          ),
          context: undefined,
        })
      ).json();
    const all = await get("");
    const first = await get("&eventsPageSize=1");
    const second = await get("&eventsPageSize=1&eventsPage=2");
    expect(all.eventsPage.total).toBeGreaterThan(1);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toEqual(all.events[0]);
    expect(second.events[0]).toEqual(all.events[1]);
    expect(first.totals).toEqual(all.totals);
    expect(first.eventsPage).toEqual({
      page: 1,
      pageSize: 1,
      total: all.eventsPage.total,
    });
    const tooBig = await handler.profitability({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports?from=2026-07-01&to=2026-09-30&eventsPageSize=5000`,
      ),
      context: undefined,
    });
    expect(tooBig.status).toBe(400);
  });

  it("pages a finalised period's stored events too", async () => {
    const f = await fixture(true, "non_cash");
    const close = await periodHandlers(() => db).close({
      actor: f.actor,
      request: req({
        from: "2026-07-01",
        to: "2026-09-30",
        note: "Synthetic paging check",
      }),
      context: undefined,
    });
    expect(close.status).toBe(201);
    const get = async (query: string) =>
      (
        await reportHandlers(() => db).gst({
          actor: f.actor,
          request: new Request(
            `${origin}/api/reports?from=2026-07-01&to=2026-09-30${query}`,
          ),
          context: undefined,
        })
      ).json();
    const all = await get("");
    const second = await get("&eventsPageSize=1&eventsPage=2");
    expect(all.finalization).toBeDefined();
    expect(all.eventsPage.total).toBeGreaterThan(1);
    expect(second.events).toEqual([all.events[1]]);
    expect(second.eventsPage).toEqual({
      page: 2,
      pageSize: 1,
      total: all.eventsPage.total,
    });
    expect(second.oneA).toBe(all.oneA);
    expect(second.finalization).toEqual(all.finalization);
  });

  it("reads only documents active in the window", async () => {
    const { financialEvents } =
      await import("../../apps/web/src/server/reports/events");
    const f = await fixture(true, "non_cash");
    const full = await db.$transaction(
      (tx) => financialEvents(tx, f.company.id),
      { isolationLevel: "RepeatableRead" },
    );
    expect(full.loaded.invoices + full.loaded.bills).toBeGreaterThan(0);
    // Nothing happens after 2099: nothing is read.
    const future = await db.$transaction(
      (tx) => financialEvents(tx, f.company.id, { since: "2099-01-01" }),
      { isolationLevel: "RepeatableRead" },
    );
    expect(future.loaded).toEqual({
      invoices: 0,
      bills: 0,
      expenses: 0,
      timesheets: 0,
    });
    expect(future.events).toEqual([]);
  });
});

describe("ageing, cash movement and accountant exports (#56)", () => {
  const ledger = () => ledgerHandlers(() => db);
  const getAgeing = async (actor: Actor, side: string, asAt: string) => {
    const response = await ledger().ageing({
      actor,
      request: new Request(
        `${origin}/api/reports/ageing?side=${side}&asAt=${asAt}`,
      ),
      context: undefined,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const runExport = (actor: Actor, name: string, query: string) =>
    exportHandlers(() => db).run({
      actor,
      request: new Request(`${origin}/api/exports/${name}?${query}`),
      context: { params: Promise.resolve({ name }) },
    });
  /** Parse our own RFC 4180 output (quoted text, bare numbers). */
  const parseCsv = (text: string) => {
    const rows: string[][] = [];
    let row: string[] = [],
      cell = "",
      quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") {
        row.push(cell);
        cell = "";
      } else if (c === "\r" && text[i + 1] === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        i += 1;
      } else cell += c;
    }
    const [header, ...body] = rows;
    return body.map((cells) =>
      Object.fromEntries(header!.map((name, i) => [name, cells[i] ?? ""])),
    );
  };
  const credited = async (actor: Actor, invoiceId: string, day: string) => {
    const invoices = invoiceHandlers(() => db);
    const created = await invoices.credit({
      actor,
      request: req({
        lines: [
          {
            description: "Synthetic partial credit",
            quantity: "1",
            unitPriceCents: "50000",
            taxCode: "TAXABLE_10",
          },
        ],
      }),
      context: context(invoiceId),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const issued = await invoices.issue({
      actor,
      request: req({ issueDate: day }),
      context: context(id),
    });
    expect(issued.status, await issued.clone().text()).toBe(200);
    return id;
  };

  it("ages debtors and creditors as at a day, as the records stood then", async () => {
    const f = await fixture(true, "non_cash");
    expect(
      (await getAgeing(f.actor, "receivables", "2026-07-14")).rows,
    ).toEqual([]);
    const first = await getAgeing(f.actor, "receivables", "2026-07-15");
    expect(first.rows).toMatchObject([
      {
        id: f.invoice.id,
        partyName: "Synthetic Customer",
        partyType: "customer",
        dueOn: "2026-07-15",
        daysOverdue: 0,
        bucket: "current",
        owed: "275000",
      },
    ]);
    const receipt = await receiptHandlers(() => db).create({
      actor: f.actor,
      request: req({
        customerId: f.customer.id,
        receivedOn: "2026-08-01",
        amountCents: "100000",
        method: "bank_transfer",
        allocations: [{ invoiceId: f.invoice.id, amountCents: "100000" }],
      }),
      context: undefined,
    });
    expect(receipt.status, await receipt.clone().text()).toBe(201);
    await credited(f.actor, f.invoice.id, "2026-08-10");
    const at = async (day: string) =>
      (await getAgeing(f.actor, "receivables", day)).rows[0];
    expect(await at("2026-07-31")).toMatchObject({
      owed: "275000",
      daysOverdue: 16,
      bucket: "days1To30",
    });
    expect(await at("2026-08-01")).toMatchObject({ owed: "175000" });
    expect(await at("2026-08-10")).toMatchObject({
      owed: "120000",
      bucket: "days1To30",
    });
    expect(await at("2026-10-20")).toMatchObject({
      owed: "120000",
      daysOverdue: 97,
      bucket: "days91Plus",
    });
    // A void today never rewrites an earlier ageing.
    const voided = await receiptHandlers(() => db).void({
      actor: f.actor,
      request: req({ reason: "Synthetic dishonoured transfer" }),
      context: context(((await receipt.json()) as { id: string }).id),
    });
    expect(voided.status).toBe(200);
    expect(await at("2026-08-15")).toMatchObject({ owed: "120000" });
    const today = await getAgeing(f.actor, "receivables", sydneyToday());
    expect(today.rows[0]).toMatchObject({ owed: "220000" });
    expect(today.totals).toMatchObject({ total: "220000" });
    expect(today.parties).toMatchObject([
      { partyId: f.customer.id, total: "220000" },
    ]);

    // Creditors: the 99000 bill less a payment and a supplier credit.
    const paid = await supplierPaymentHandlers(() => db).create({
      actor: f.actor,
      request: req({
        paidOn: "2026-07-20",
        amountCents: "40000",
        method: "bank_transfer",
        allocations: [{ billId: f.supplier.id, amountCents: "40000" }],
      }),
      context: undefined,
    });
    expect(paid.status, await paid.clone().text()).toBe(201);
    const credit = await supplierCreditHandlers(() => db).create({
      actor: f.actor,
      request: req({
        supplierReference: "CN-AGE-1",
        issuedOn: "2026-07-21",
        receivedOn: "2026-07-21",
        lines: [
          {
            description: "Synthetic price adjustment",
            taxCode: "TAXABLE_10",
            exclusiveCents: "10000",
            gstCents: "1000",
          },
        ],
      }),
      context: context(f.supplier.id),
    });
    expect(credit.status, await credit.clone().text()).toBe(201);
    const payable = async (day: string) =>
      (await getAgeing(f.actor, "payables", day)).rows[0];
    expect(await payable("2026-07-19")).toMatchObject({ owed: "99000" });
    expect(await payable("2026-07-20")).toMatchObject({ owed: "59000" });
    expect(await payable("2026-07-21")).toMatchObject({
      owed: "48000",
      partyType: "contractor",
      partyName: "Synthetic Contractor",
    });
    // Paging the rows keeps the totals.
    const paged = await ledger().ageing({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports/ageing?side=payables&asAt=2026-07-21&pageSize=1&page=2`,
      ),
      context: undefined,
    });
    expect(await paged.json()).toMatchObject({
      rows: [],
      rowsPage: { page: 2, pageSize: 1, total: 1 },
      totals: { total: "48000" },
    });
    for (const bad of [
      "side=both&asAt=2026-07-21",
      "side=payables&asAt=bad",
      "side=payables&asAt=2026-07-21&pageSize=5000",
    ])
      expect(
        (
          await ledger().ageing({
            actor: f.actor,
            request: new Request(`${origin}/api/reports/ageing?${bad}`),
            context: undefined,
          })
        ).status,
      ).toBe(400);
  });

  it("ageing reconciles with recorded balances and a full read, for every company", async () => {
    const { receivablesSource, payablesSource } =
      await import("../../apps/web/src/server/reports/ledger");
    const { ageingReport } = await import("../../packages/domain/src/index");
    const companies = await db.company.findMany({ select: { id: true } });
    const days = [
      "2026-01-01",
      "2026-07-15",
      "2026-07-20",
      "2026-08-01",
      "2026-08-31",
      "2026-09-30",
      sydneyToday(),
      "2099-12-31",
    ];
    let compared = 0;
    for (const { id } of companies) {
      for (const asAt of days)
        for (const load of [receivablesSource, payablesSource]) {
          const [bounded, full] = await db.$transaction(
            async (tx) => [
              await load(tx, id, asAt),
              await load(tx, id, asAt, { bounded: false }),
            ],
            { isolationLevel: "RepeatableRead" },
          );
          const report = ageingReport(bounded.documents, asAt);
          expect(report, `${id} ${load.name} ${asAt}`).toEqual(
            ageingReport(full.documents, asAt),
          );
          // Narrowed reads load nothing that's fully settled.
          expect(bounded.documents.length).toBe(report.rows.length);
          compared += 1;
        }
      // As at the far future, ageing equals today's recorded balances.
      const [receivable] = await db.$queryRaw<{ owed: bigint | null }[]>`
        SELECT SUM(GREATEST(0, i.inclusive_cents
          - COALESCE((SELECT SUM(CASE WHEN r.kind='refund' THEN -a.amount_cents ELSE a.amount_cents END)
              FROM receipt_allocations a JOIN customer_receipts r ON r.id=a.receipt_id
              WHERE a.invoice_id=i.id AND r.voided_at IS NULL),0)
          - COALESCE((SELECT SUM(c.inclusive_cents) FROM invoices c
              WHERE c.credits_id=i.id AND c.status='issued'),0)))::bigint AS owed
        FROM invoices i WHERE i.company_id=${id}::uuid AND i.kind='invoice' AND i.status='issued'`;
      const [payable] = await db.$queryRaw<{ owed: bigint | null }[]>`
        SELECT SUM(GREATEST(0, b.inclusive_cents
          - COALESCE((SELECT SUM(a.amount_cents) FROM supplier_payment_allocations a
              JOIN supplier_payments p ON p.id=a.payment_id
              WHERE a.bill_id=b.id AND p.voided_at IS NULL),0)
          - COALESCE((SELECT SUM(c.inclusive_cents) FROM supplier_credits c
              WHERE c.bill_id=b.id AND c.voided_at IS NULL),0)))::bigint AS owed
        FROM supplier_bills b WHERE b.company_id=${id}::uuid AND b.voided_at IS NULL`;
      const totals = await db.$transaction(
        async (tx) => [
          ageingReport(
            (await receivablesSource(tx, id, "2099-12-31")).documents,
            "2099-12-31",
          ).totals.total,
          ageingReport(
            (await payablesSource(tx, id, "2099-12-31")).documents,
            "2099-12-31",
          ).totals.total,
        ],
        { isolationLevel: "RepeatableRead" },
      );
      expect(totals, id).toEqual([receivable?.owed ?? 0n, payable?.owed ?? 0n]);
    }
    expect(compared).toBeGreaterThan(100);
  }, 300_000);

  it("cash movement is receipts less payments, labelled not profit, for every company", async () => {
    const { cashMovement } =
      await import("../../apps/web/src/server/reports/ledger");
    const { financialEvents } =
      await import("../../apps/web/src/server/reports/events");
    const { profitabilityReport } =
      await import("../../packages/domain/src/index");
    const companies = await db.company.findMany({ select: { id: true } });
    for (const { id } of companies)
      for (const range of [
        { from: "2026-07-01", to: "2026-09-30" },
        { from: "2026-07-20", to: sydneyToday() },
        { from: "2000-01-01", to: "2099-12-31" },
      ]) {
        const [cash, full] = await db.$transaction(
          async (tx) => [
            await cashMovement(tx, id, range),
            await financialEvents(tx, id),
          ],
          { isolationLevel: "RepeatableRead" },
        );
        const profit = profitabilityReport(full.events, range).totals;
        expect(cash).toMatchObject({
          label: "Cash movement — money in less money out, not profit",
          moneyIn: profit.receivedInclusive,
          moneyOut: profit.paidInclusive,
          net: profit.receivedInclusive - profit.paidInclusive,
        });
        expect(cash.months.reduce((t, m) => t + m.net, 0n)).toBe(cash.net);
      }
    const f = await fixture(true, "cash");
    const response = await ledger().cash({
      actor: f.actor,
      request: new Request(
        `${origin}/api/reports/cash?from=2026-07-01&to=2026-07-31`,
      ),
      context: undefined,
    });
    // Two expenses paid at purchase: 16500 + 10000 out, nothing in yet.
    expect(await response.json()).toMatchObject({
      range: { from: "2026-07-01", to: "2026-07-31" },
      moneyIn: "0",
      moneyOut: "26500",
      net: "-26500",
      months: [{ month: "2026-07", moneyOut: "26500", net: "-26500" }],
    });
    expect(
      (
        await ledger().cash({
          actor: f.actor,
          request: new Request(
            `${origin}/api/reports/cash?from=2026-08-01&to=2026-07-31`,
          ),
          context: undefined,
        })
      ).status,
    ).toBe(400);
  });

  it("exports machine-readable CSV that matches the reports, with formula cells neutralised", async () => {
    const f = await fixture(true, "non_cash");
    await db.customer.update({
      where: { id: f.customer.id },
      data: { name: '=HYPERLINK("http://example.test","Synthetic")' },
    });
    await credited(f.actor, f.invoice.id, "2026-08-10");
    expect(
      (
        await billHandlers(() => db).void({
          actor: f.actor,
          request: req({ reason: "Synthetic duplicate bill" }),
          context: context(f.supplier.id),
        })
      ).status,
    ).toBe(200);
    const range = "from=2026-07-01&to=2026-09-30";
    const json = await (
      await reportHandlers(() => db).gst({
        actor: f.actor,
        request: new Request(`${origin}/api/reports/gst?${range}`),
        context: undefined,
      })
    ).json();
    const before = await db.auditEvent.count({
      where: { companyId: f.company.id, action: "report.exported" },
    });
    const numeric = /^-?\d+$/;
    const texts: Record<string, string> = {};
    for (const [name, query] of [
      ["gst-summary", range],
      ["gst-lines", range],
      ["profitability", range],
      ["cash", range],
      ["ageing", "side=receivables&asAt=2026-08-31"],
      ["ageing", "side=payables&asAt=2026-07-31"],
    ] as const) {
      const response = await runExport(f.actor, name, query);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment; filename="jobflow-[a-z0-9-]+\.csv"$/,
      );
      const text = await response.text();
      texts[`${name}:${query}`] = text;
      expect(text).not.toMatch(/[−$]/);
      expect(text.endsWith("\r\n")).toBe(true);
      for (const row of parseCsv(text))
        for (const [column, value] of Object.entries(row))
          if (
            /_cents$|^days_overdue$|^margin_basis_points$|^revision$/.test(
              column,
            )
          )
            expect(value, `${name} ${column}`).toMatch(
              value === "" ? /^$/ : numeric,
            );
    }
    const [summary] = parseCsv(texts[`gst-summary:${range}`]!);
    expect(summary).toMatchObject({
      status: "draft",
      revision: "",
      g1_total_sales_inclusive_cents: json.g1,
      label_1a_gst_on_sales_cents: json.oneA,
      label_1b_gst_on_purchases_cents: json.oneB,
      net_gst_cents: json.netGst,
      label: "Draft BAS/GST summary — not lodged",
    });
    const lines = parseCsv(texts[`gst-lines:${range}`]!);
    const total = (label: string) =>
      lines
        .filter((l) => l.bas_label === label)
        .reduce((t, l) => t + BigInt(l.gst_cents!), 0n)
        .toString();
    expect([total("1A"), total("1B")]).toEqual([json.oneA, json.oneB]);
    // The credit note and the voided bill export as negative ASCII cents.
    expect(lines.some((l) => l.source_type === "credit_note")).toBe(true);
    expect(lines.some((l) => l.gst_cents!.startsWith("-"))).toBe(true);
    expect(lines.find((l) => l.source_type === "invoice")?.party_name).toBe(
      '\'=HYPERLINK("http://example.test","Synthetic")',
    );
    const [receivable] = parseCsv(
      texts["ageing:side=receivables&asAt=2026-08-31"]!,
    );
    expect(receivable).toMatchObject({
      party_name: '\'=HYPERLINK("http://example.test","Synthetic")',
      owed_inclusive_cents: "220000",
      bucket: "days31To60",
    });
    const profit = parseCsv(texts[`profitability:${range}`]!);
    expect(profit.map((r) => r.row_type)).toEqual([
      "job",
      "unallocated",
      "total",
    ]);
    expect(
      await db.auditEvent.count({
        where: { companyId: f.company.id, action: "report.exported" },
      }),
    ).toBe(before + 6);
    // Refused requests read and record nothing.
    expect((await runExport(f.actor, "gst-lines", "from=bad")).status).toBe(
      400,
    );
    expect((await runExport(f.actor, "ageing", range)).status).toBe(400);
    expect((await runExport(f.actor, "payroll", range)).status).toBe(404);
    expect(
      await db.auditEvent.count({
        where: { companyId: f.company.id, action: "report.exported" },
      }),
    ).toBe(before + 6);

    // A finalised period exports its locked revision.
    expect(
      (
        await periodHandlers(() => db).close({
          actor: f.actor,
          request: req({
            from: "2026-07-01",
            to: "2026-09-30",
            note: "Synthetic export period",
          }),
          context: undefined,
        })
      ).status,
    ).toBe(201);
    const [locked] = parseCsv(
      await (await runExport(f.actor, "gst-summary", range)).text(),
    );
    expect(locked).toMatchObject({
      status: "finalised",
      revision: "1",
      net_gst_cents: json.netGst,
    });
    const lockedLines = parseCsv(
      await (await runExport(f.actor, "gst-lines", range)).text(),
    );
    expect(lockedLines.map((l) => [l.event_id, l.gst_cents])).toEqual(
      lines.map((l) => [l.event_id, l.gst_cents]),
    );
    expect(lockedLines.every((l) => l.period_status === "finalised")).toBe(
      true,
    );
    // Screens (#58): drill-down events carry their sources' labels, for
    // live and finalised reports alike, and finalised events are paged too.
    for (const url of [
      `${origin}/api/reports/gst?${range}&eventsPageSize=2`,
      `${origin}/api/reports/profitability?${range}&eventsPageSize=2`,
    ]) {
      const handler = url.includes("/gst")
        ? reportHandlers(() => db).gst
        : reportHandlers(() => db).profitability;
      const body = await (
        await handler({
          actor: f.actor,
          request: new Request(url),
          context: undefined,
        })
      ).json();
      expect(body.events).toHaveLength(2);
      expect(body.eventsPage).toMatchObject({ page: 1, pageSize: 2 });
      expect(body.eventsPage.total).toBeGreaterThan(2);
      for (const event of body.events)
        expect(body.eventSources[event.sourceId]).toMatchObject({
          type: expect.stringMatching(
            /^(invoice|credit_note|supplier_bill|expense|timesheet)$/,
          ),
        });
      expect(Object.keys(body.eventSources).length).toBeLessThanOrEqual(2);
    }
    const lockedJson = await (
      await reportHandlers(() => db).gst({
        actor: f.actor,
        request: new Request(`${origin}/api/reports/gst?${range}`),
        context: undefined,
      })
    ).json();
    expect(lockedJson.finalization.revision).toBe(1);
    expect(lockedJson.eventSources[f.invoice.id]).toMatchObject({
      type: "invoice",
      party: '=HYPERLINK("http://example.test","Synthetic")',
    });
  });

  it("labels cash-basis GST lines with their receipt or payment", async () => {
    const f = await fixture(true, "cash");
    expect(
      (
        await receiptHandlers(() => db).create({
          actor: f.actor,
          request: req({
            customerId: f.customer.id,
            receivedOn: "2026-07-15",
            amountCents: "100000",
            method: "bank_transfer",
            reference: "Synthetic remittance",
            allocations: [{ invoiceId: f.invoice.id, amountCents: "100000" }],
          }),
          context: undefined,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await supplierPaymentHandlers(() => db).create({
          actor: f.actor,
          request: req({
            paidOn: "2026-07-15",
            amountCents: "40000",
            method: "card",
            allocations: [{ billId: f.supplier.id, amountCents: "40000" }],
          }),
          context: undefined,
        })
      ).status,
    ).toBe(201);
    const lines = parseCsv(
      await (
        await runExport(f.actor, "gst-lines", "from=2026-07-01&to=2026-09-30")
      ).text(),
    );
    const settled = lines.filter((l) =>
      ["customer_receipt", "supplier_payment"].includes(l.source_type!),
    );
    expect(settled.find((l) => l.bas_label === "1A")).toMatchObject({
      source_type: "customer_receipt",
      source_reference: "Synthetic remittance",
      party_name: expect.stringMatching(/\S/),
    });
    // Without a reference, the payment method identifies it.
    expect(settled.find((l) => l.bas_label === "1B")).toMatchObject({
      source_type: "supplier_payment",
      source_reference: "card",
      party_name: expect.stringMatching(/\S/),
    });
    expect(lines.filter((l) => l.source_type === "")).toEqual([]);
  });

  it("exports profitability for one job, as the filtered report shows it", async () => {
    const f = await fixture(true, "non_cash");
    const range = "from=2026-07-01&to=2026-09-30";
    const report = await (
      await reportHandlers(() => db).profitability({
        actor: f.actor,
        request: new Request(
          `${origin}/api/reports?${range}&jobId=${f.job.id}`,
        ),
        context: undefined,
      })
    ).json();
    const rows = parseCsv(
      await (
        await runExport(f.actor, "profitability", `${range}&jobId=${f.job.id}`)
      ).text(),
    );
    expect(
      rows.filter((r) => r.row_type === "job").map((r) => r.job_id),
    ).toEqual([f.job.id]);
    expect(rows.find((r) => r.row_type === "total")).toMatchObject({
      revenue_exclusive_cents: report.totals.revenue,
      job_cost_exclusive_cents: report.totals.cost,
      gross_profit_cents: report.totals.profit,
    });
    // Another company's job, or a malformed id, reads nothing.
    const other = await fixture(true, "non_cash");
    await expect(
      runExport(f.actor, "profitability", `${range}&jobId=${other.job.id}`),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await runExport(f.actor, "profitability", `${range}&jobId=nope`)).status,
    ).toBe(400);
  });

  it("only owners and accountants reach ageing, cash and exports", async () => {
    const f = await fixture(false, "non_cash");
    const auth = createAuth({
      db,
      secret: randomBytes(32).toString("hex"),
      baseURL: origin,
      production: false,
    });
    const policy = createWithPolicy({
      auth: () => auth,
      db: () => db,
      trustedOrigins: () => [origin],
    });
    const routes = [
      [
        policy("ledger_report.read", ledger().ageing),
        `${origin}/api/reports/ageing?side=receivables&asAt=2026-08-31`,
        undefined,
      ],
      [
        policy("ledger_report.read", ledger().cash),
        `${origin}/api/reports/cash?from=2026-07-01&to=2026-09-30`,
        undefined,
      ],
      [
        policy("export.run", exportHandlers(() => db).run),
        `${origin}/api/exports/gst-lines?from=2026-07-01&to=2026-09-30`,
        { params: Promise.resolve({ name: "gst-lines" }) },
      ],
    ] as const;
    for (const [route, url, ctx] of routes)
      expect((await route(new Request(url), ctx as never)).status).toBe(401);
    for (const role of [
      "owner",
      "accountant",
      "manager",
      "employee",
      "subcontractor",
    ] as Role[]) {
      const user = await createCredentialUser(db, {
        email: `ledger-${randomUUID()}@example.test`,
        name: "Synthetic Role",
        password,
      });
      await db.membership.create({
        data: {
          companyId: f.company.id,
          userId: user.id,
          role,
          createdBy: f.user.id,
        },
      });
      const login = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            "x-forwarded-for": `198.51.100.${role.length + 20}`,
          },
          body: JSON.stringify({ email: user.email, password }),
        }),
      );
      expect(login.status).toBe(200);
      const headers = {
        cookie: login.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; "),
      };
      for (const [route, url, ctx] of routes)
        expect(
          (await route(new Request(url, { headers }), ctx as never)).status,
          `${role} ${url}`,
        ).toBe(["owner", "accountant"].includes(role) ? 200 : 403);
    }
  }, 120_000);
});

describe("reversing a correction of a paid expense (#169)", () => {
  it("reverses the correction's cash-basis claim too", async () => {
    const f = await fixture(true, "cash");
    const expenses = expenseHandlers(() => db);
    const [originalId] = f.expenseIds; // $150 + $15 taxable, paid at purchase
    const today = async () =>
      (
        await (
          await reportHandlers(() => db).gst({
            actor: f.actor,
            request: new Request(
              `${origin}/api/reports?from=${sydneyToday()}&to=${sydneyToday()}`,
            ),
            context: undefined,
          })
        ).json()
      ).oneB as string;
    const reverse = (id: string) =>
      expenses.reverse({
        actor: f.actor,
        request: req({ note: "Synthetic correction" }),
        context: context(id),
      });
    expect((await reverse(originalId!)).status).toBe(201);
    const corrected = await expenses.create({
      actor: f.actor,
      request: req({
        jobId: f.job.id,
        category: "materials",
        description: "Synthetic purchase (50% business use)",
        purchasedOn: "2026-07-15",
        priceEntry: "exclusive",
        amountCents: "15000",
        taxCode: "TAXABLE_10",
        creditablePercent: "50",
        receiptDocumentId: await f.doc(),
        settlement: "paid_at_purchase",
        paymentMethod: "card",
        correctsExpenseId: originalId,
      }),
      context: undefined,
    });
    expect(corrected.status, await corrected.clone().text()).toBe(201);
    const { id: correctionId } = (await corrected.json()) as { id: string };
    expect(
      (
        await expenses.decide({
          actor: f.actor,
          request: req({ decision: "approve", evidenceVerified: true }),
          context: context(correctionId),
        })
      ).status,
    ).toBe(200);
    // Reversal −1500 and correction +750, both dated today.
    expect(await today()).toBe("-750");
    expect((await reverse(correctionId)).status).toBe(201);
    // The correction's 750 comes back off: the chain nets to the reversal.
    expect(await today()).toBe("-1500");
  });
});
