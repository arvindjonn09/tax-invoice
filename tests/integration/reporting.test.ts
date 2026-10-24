import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import { receiptHandlers } from "../../apps/web/src/server/receipts/handlers";
import {
  billHandlers,
  supplierPaymentHandlers,
} from "../../apps/web/src/server/bills/handlers";
import { expenseHandlers } from "../../apps/web/src/server/expenses/handlers";
import { periodHandlers } from "../../apps/web/src/server/reports/periods";
import { sydneyToday } from "../../apps/web/src/server/company/gst";
import { reportHandlers } from "../../apps/web/src/server/reports/handlers";
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
  return { actor, user, company, customer, job, invoice, supplier, expenseIds };
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
    await expect(createReceipt()).rejects.toThrow(/jobflow_period_locked/);
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
      receivedOn: "2026-07-16",
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
    ).toBe(0);
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
