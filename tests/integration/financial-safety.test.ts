import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { jobProfit } from "../../packages/domain/src/index";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  billHandlers,
  supplierPaymentHandlers,
} from "../../apps/web/src/server/bills/handlers";
import { expenseHandlers } from "../../apps/web/src/server/expenses/handlers";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import { receiptHandlers } from "../../apps/web/src/server/receipts/handlers";
import {
  rateHandlers,
  timesheetHandlers,
} from "../../apps/web/src/server/timesheets/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #52: money stays consistent across modules under retries, races, bad
// amounts and corrections. Every case checks document balances AND job
// profit (R10: GST-exclusive revenue net of credits, minus incurred cost;
// receipts, refunds and payments never move profit).
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "manager", "accountant", "employee"] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let companyId = "";
let customerId = "";
let employeeId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x5252);
let handlers: {
  invoices: ReturnType<typeof invoiceHandlers>;
  receipts: ReturnType<typeof receiptHandlers>;
  bills: ReturnType<typeof billHandlers>;
  payments: ReturnType<typeof supplierPaymentHandlers>;
  expenses: ReturnType<typeof expenseHandlers>;
  timesheets: ReturnType<typeof timesheetHandlers>;
  rates: ReturnType<typeof rateHandlers>;
};

beforeAll(async () => {
  database = await withCommittedDatabase();
  db = database.client;
  const auth = createAuth({
    db,
    secret: randomBytes(32).toString("hex"),
    baseURL: ORIGIN,
    production: false,
  });
  withPolicy = createWithPolicy({
    auth: () => auth,
    db: () => db,
    trustedOrigins: () => [ORIGIN],
  });
  handlers = {
    invoices: invoiceHandlers(() => db),
    receipts: receiptHandlers(() => db),
    bills: billHandlers(() => db),
    payments: supplierPaymentHandlers(() => db),
    expenses: expenseHandlers(() => db),
    timesheets: timesheetHandlers(() => db),
    rates: rateHandlers(() => db),
  };
  for (const key of WHO) {
    userIds[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
        name: `Synthetic ${key}`,
        password: PASSWORD,
      })
    ).id;
  }
  const own = factory.company(userIds.owner);
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: own });
    await tx.membership.create({
      data: factory.membership(own.id, userIds.owner),
    });
  });
  companyId = own.id;
  await db.company.update({
    where: { id: companyId },
    data: { legalName: "Sample Pty Ltd", abn: syntheticAbn("525252525") },
  });
  await db.companyGstRegistration.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      startsOn: new Date("2025-07-01T00:00:00Z"),
      basis: "cash",
    },
  });
  for (const role of ["manager", "accountant", "employee"] as const)
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[role],
        createdBy: userIds.owner,
        role,
      },
    });
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
    })
  ).id;
  employeeId = (
    await db.employee.create({
      data: {
        companyId,
        name: "Synthetic employee",
        userId: userIds.employee,
        createdBy: userIds.owner,
      },
    })
  ).id;
  let ip = 0;
  for (const key of WHO) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": `203.0.113.${(ip += 1)}`,
        },
        body: JSON.stringify({
          email: `${key}@jobflow.invalid`,
          password: PASSWORD,
        }),
      }),
    );
    expect(response.status).toBe(200);
    cookies[key] = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
  }
  expect(
    (
      await r().addRate(
        call("manager", "POST", {
          effectiveFrom: "2026-01-01",
          hourlyCostCents: "5000",
        }),
        one(employeeId),
      )
    ).status,
  ).toBe(201);
}, 120_000);
afterAll(() => database?.release());

function call(
  who: Who,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const h = new Headers(cookies[who]);
  h.set("origin", ORIGIN);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/x`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  invCreate: withPolicy("invoice.write", handlers.invoices.create),
  invIssue: withPolicy<One>("invoice.issue", handlers.invoices.issue),
  invCredit: withPolicy<One>("invoice.write", handlers.invoices.credit),
  invVoid: withPolicy<One>("invoice.issue", handlers.invoices.void),
  invRead: withPolicy<One>("invoice.read", handlers.invoices.read),
  receive: withPolicy("payment.write", handlers.receipts.create),
  voidReceipt: withPolicy<One>("payment.write", handlers.receipts.void),
  bill: withPolicy("bill.write", handlers.bills.create),
  readBill: withPolicy<One>("bill.read", handlers.bills.read),
  voidBill: withPolicy<One>("bill.write", handlers.bills.void),
  pay: withPolicy("payment.write", handlers.payments.create),
  voidPayment: withPolicy<One>("payment.write", handlers.payments.void),
  expense: withPolicy("expense.submit_own", handlers.expenses.create),
  decideExpense: withPolicy<One>("expense.approve", handlers.expenses.decide),
  reverseExpense: withPolicy<One>("expense.approve", handlers.expenses.reverse),
  time: withPolicy("timesheet.submit_own", handlers.timesheets.create),
  decideTime: withPolicy<One>("timesheet.approve", handlers.timesheets.decide),
  reverseTime: withPolicy<One>(
    "timesheet.approve",
    handlers.timesheets.reverse,
  ),
  addRate: withPolicy<One>("employee.write", handlers.rates.add),
});

let jobNumber = 0;
/** A job with the synthetic employee assigned, ready for every cost source. */
async function newJob() {
  jobNumber += 1;
  const job = await db.job.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      customerId,
      number: jobNumber,
      reference: `JOB-52-${jobNumber}`,
      title: `Synthetic money job ${jobNumber}`,
      status: "in_progress",
    },
  });
  await db.assignment.create({
    data: { companyId, jobId: job.id, employeeId, createdBy: userIds.owner },
  });
  return job.id;
}

/**
 * Test oracle for job profit, read straight from the ledger: issued
 * invoices less issued credit notes (ex GST), minus incurred cost from live
 * bills, approved expenses and approved timesheets (reversals are approved
 * negative rows). Only GST-exclusive amounts and non-creditable GST
 * (inside job_cost_cents) can reach it.
 */
async function profitOf(jobId: string) {
  const [invoices, bills, expenses, timesheets] = await Promise.all([
    db.invoice.findMany({ where: { companyId, jobId, status: "issued" } }),
    db.supplierBill.findMany({ where: { companyId, jobId, voidedAt: null } }),
    db.expense.findMany({ where: { companyId, jobId, status: "approved" } }),
    db.timesheet.findMany({ where: { companyId, jobId, status: "approved" } }),
  ]);
  const result = jobProfit({
    revenueExclusive: invoices.map((row) =>
      row.kind === "credit_note" ? -row.exclusiveCents : row.exclusiveCents,
    ),
    jobCosts: [
      ...bills.map((row) => row.jobCostCents),
      // An approved row always carries its cost; a null would hide a bug.
      ...expenses.map((row) => {
        if (row.jobCostCents === null)
          throw new Error("approved expense without cost");
        return row.jobCostCents;
      }),
      ...timesheets.map((row) => {
        if (row.costCents === null)
          throw new Error("approved timesheet without cost");
        return row.costCents;
      }),
    ],
  });
  return { revenue: result.revenue, cost: result.cost, profit: result.profit };
}

/** Customer-side balance from the API, plus credits and overpayment from the ledger. */
async function invoiceBalance(invoiceId: string) {
  const view = (await (
    await r().invRead(call("accountant", "GET"), one(invoiceId))
  ).json()) as {
    status: string;
    inclusiveCents: string;
    // Absent once void: nothing is receivable on a void invoice.
    receivedCents?: string;
    outstandingCents?: string;
  };
  const received = BigInt(view.receivedCents ?? "0");
  const credits = await db.invoice.findMany({
    where: { creditsId: invoiceId, status: "issued" },
  });
  const credited = credits.reduce((t, row) => t + row.inclusiveCents, 0n);
  const net = BigInt(view.inclusiveCents) - credited;
  return {
    status: view.status,
    received,
    credited,
    outstanding: BigInt(view.outstandingCents ?? "0"),
    // Credited after being paid: owed back to the customer as a refund.
    overpaid: received > net ? received - net : 0n,
  };
}

async function billBalance(billId: string) {
  const view = (await (
    await r().readBill(call("accountant", "GET"), one(billId))
  ).json()) as { status: string; paidCents: string; outstandingCents: string };
  return {
    status: view.status,
    paid: BigInt(view.paidCents),
    outstanding: BigInt(view.outstandingCents),
  };
}

const LINE = {
  description: "Synthetic install",
  quantity: "1",
  taxCode: "TAXABLE_10",
};

async function draftInvoice(jobId: string, exclusive = "250000") {
  const response = await r().invCreate(
    call("accountant", "POST", {
      customerId,
      jobId,
      lines: [{ ...LINE, unitPriceCents: exclusive }],
    }),
    undefined,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const issue = (id: string) =>
  r().invIssue(
    call("accountant", "POST", { issueDate: "2026-07-01" }),
    one(id),
  );

/** An issued $2,500 + $250 GST invoice on the job. */
async function issuedInvoice(jobId: string) {
  const id = await draftInvoice(jobId);
  expect((await issue(id)).status).toBe(200);
  return id;
}

async function draftCredit(invoiceId: string, exclusive: string) {
  const response = await r().invCredit(
    call("accountant", "POST", {
      lines: [{ ...LINE, description: "Credit", unitPriceCents: exclusive }],
    }),
    one(invoiceId),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

function money(
  invoiceId: string,
  amount: unknown,
  { kind = "receipt", key = `key-${randomUUID()}` } = {},
) {
  return r().receive(
    call(
      "accountant",
      "POST",
      {
        customerId,
        kind,
        receivedOn: "2026-07-05",
        amountCents: amount,
        method: "bank_transfer",
        allocations: [{ invoiceId, amountCents: amount }],
      },
      { "idempotency-key": key },
    ),
    undefined,
  );
}

async function document() {
  return (
    await db.document.create({
      data: {
        companyId,
        kind: "tax_invoice",
        objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
        fileName: "synthetic-tax-invoice.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        sha256: "b".repeat(64),
        createdBy: userIds.accountant,
      },
    })
  ).id;
}

/** A $900 + $90 GST supplier bill on the job, with verified tax-invoice evidence. */
async function recordBill(jobId: string, lines?: unknown) {
  return r().bill(
    call("accountant", "POST", {
      jobId,
      supplierName: "Sample Wholesale",
      supplierAbn: syntheticAbn("525252530"),
      supplierGstRegistered: true,
      issuedOn: "2026-07-02",
      documentId: await document(),
      evidenceVerified: true,
      lines: lines ?? [
        {
          description: "Synthetic materials",
          taxCode: "TAXABLE_10",
          exclusiveCents: "90000",
          gstCents: "9000",
        },
      ],
    }),
    undefined,
  );
}

function payBill(billId: string, amount: unknown, key = randomUUID()) {
  return r().pay(
    call(
      "accountant",
      "POST",
      {
        paidOn: "2026-07-06",
        amountCents: amount,
        method: "bank_transfer",
        allocations: [{ billId, amountCents: amount }],
      },
      { "idempotency-key": key },
    ),
    undefined,
  );
}

const statuses = (responses: Response[]) =>
  responses.map((response) => response.status).sort();

describe("financial safety (#52)", () => {
  it("one job through invoice, receipts, credit, refund, bill, payment, expense and labour: balances and profit at every step", async () => {
    const jobId = await newJob();
    const invoiceId = await issuedInvoice(jobId);
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      received: 0n,
      outstanding: 275_000n,
    });
    expect(await profitOf(jobId)).toEqual({
      revenue: 250_000n,
      cost: 0n,
      profit: 250_000n,
    });

    // A retried receipt (five concurrent submissions, one key) lands once.
    const key = `retry-${randomUUID()}`;
    const retries = await Promise.all(
      Array.from({ length: 5 }, () => money(invoiceId, "100000", { key })),
    );
    expect(statuses(retries)).toEqual([200, 200, 200, 200, 201]);
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      received: 100_000n,
      outstanding: 175_000n,
    });
    expect((await profitOf(jobId)).profit).toBe(250_000n);

    expect((await money(invoiceId, "175000")).status).toBe(201);
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      received: 275_000n,
      outstanding: 0n,
    });

    // A $500 + $50 credit after full payment: revenue drops, the customer
    // is owed $550 back, and nothing more can be received.
    const creditId = await draftCredit(invoiceId, "50000");
    expect((await issue(creditId)).status).toBe(200);
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      credited: 55_000n,
      outstanding: 0n,
      overpaid: 55_000n,
    });
    expect(await profitOf(jobId)).toEqual({
      revenue: 200_000n,
      cost: 0n,
      profit: 200_000n,
    });
    expect((await money(invoiceId, "1")).status).toBe(400);

    // Refunding more than was received is refused; the exact refund settles it.
    expect((await money(invoiceId, "275001", { kind: "refund" })).status).toBe(
      400,
    );
    expect((await money(invoiceId, "55000", { kind: "refund" })).status).toBe(
      201,
    );
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      received: 220_000n,
      outstanding: 0n,
      overpaid: 0n,
    });
    expect((await profitOf(jobId)).profit).toBe(200_000n);

    // Supplier bill: creditable GST stays out of cost; payments and their
    // voids move the bill balance only.
    const billResponse = await recordBill(jobId);
    expect(billResponse.status).toBe(201);
    const bill = (await billResponse.json()) as {
      id: string;
      jobCostCents: string;
    };
    expect(bill.jobCostCents).toBe("90000");
    expect(await profitOf(jobId)).toEqual({
      revenue: 200_000n,
      cost: 90_000n,
      profit: 110_000n,
    });
    const paid = await payBill(bill.id, "40000");
    expect(paid.status).toBe(201);
    expect(await billBalance(bill.id)).toMatchObject({
      paid: 40_000n,
      outstanding: 59_000n,
    });
    expect((await profitOf(jobId)).profit).toBe(110_000n);
    const paymentId = ((await paid.json()) as { id: string }).id;
    expect(
      (
        await r().voidPayment(
          call("accountant", "POST", { reason: "Bank bounced it" }),
          one(paymentId),
        )
      ).status,
    ).toBe(200);
    expect(await billBalance(bill.id)).toMatchObject({
      paid: 0n,
      outstanding: 99_000n,
    });
    expect((await profitOf(jobId)).profit).toBe(110_000n);

    // A half-creditable expense: the $7.50 non-creditable GST is job cost.
    const submitted = await r().expense(
      call("manager", "POST", {
        jobId,
        category: "materials",
        description: "Synthetic fittings",
        supplierName: "Sample Hardware",
        purchasedOn: "2026-07-03",
        priceEntry: "exclusive",
        amountCents: "15000",
        taxCode: "TAXABLE_10",
        creditablePercent: "50",
        receiptDocumentId: await document(),
        settlement: "paid_at_purchase",
        paymentMethod: "card",
      }),
      undefined,
    );
    expect(submitted.status).toBe(201);
    const expenseId = ((await submitted.json()) as { id: string }).id;
    expect(
      (
        await r().decideExpense(
          call("manager", "POST", {
            decision: "approve",
            evidenceVerified: true,
          }),
          one(expenseId),
        )
      ).status,
    ).toBe(200);
    expect(await profitOf(jobId)).toEqual({
      revenue: 200_000n,
      cost: 105_750n,
      profit: 94_250n,
    });

    // Concurrent reversals of the same expense record exactly one.
    const expenseReversals = await Promise.all(
      Array.from({ length: 3 }, () =>
        r().reverseExpense(
          call("manager", "POST", { note: "Wrong job" }),
          one(expenseId),
        ),
      ),
    );
    expect(statuses(expenseReversals)).toEqual([201, 409, 409]);
    expect(await db.expense.count({ where: { reversesId: expenseId } })).toBe(
      1,
    );
    expect((await profitOf(jobId)).cost).toBe(90_000n);

    // Six hours at $50/h, approved once, reversed once.
    const logged = await r().time(
      call("employee", "POST", {
        jobId,
        workDate: "2026-07-02",
        minutes: 360,
      }),
      undefined,
    );
    expect(logged.status).toBe(201);
    const timesheetId = ((await logged.json()) as { id: string }).id;
    const approvals = await Promise.all(
      Array.from({ length: 3 }, () =>
        r().decideTime(
          call("manager", "POST", { decision: "approve" }),
          one(timesheetId),
        ),
      ),
    );
    expect(statuses(approvals)).toEqual([200, 409, 409]);
    expect(await profitOf(jobId)).toEqual({
      revenue: 200_000n,
      cost: 120_000n,
      profit: 80_000n,
    });
    const timeReversals = await Promise.all(
      Array.from({ length: 3 }, () =>
        r().reverseTime(
          call("manager", "POST", { note: "Logged twice" }),
          one(timesheetId),
        ),
      ),
    );
    expect(statuses(timeReversals)).toEqual([201, 409, 409]);
    expect(
      await db.timesheet.count({ where: { reversesId: timesheetId } }),
    ).toBe(1);

    // Final position: money settled exactly, profit from GST-exclusive amounts.
    expect(await profitOf(jobId)).toEqual({
      revenue: 200_000n,
      cost: 90_000n,
      profit: 110_000n,
    });
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      received: 220_000n,
      credited: 55_000n,
      outstanding: 0n,
      overpaid: 0n,
    });
    expect(await billBalance(bill.id)).toMatchObject({
      paid: 0n,
      outstanding: 99_000n,
    });
  }, 60_000);

  it("issues a draft once when the issue is submitted concurrently", async () => {
    const jobId = await newJob();
    const id = await draftInvoice(jobId);
    const results = await Promise.all([issue(id), issue(id), issue(id)]);
    expect(statuses(results)).toEqual([200, 409, 409]);
    const issued = await db.invoice.findUniqueOrThrow({ where: { id } });
    expect(issued.reference).toMatch(/^INV-/);
    expect(await profitOf(jobId)).toEqual({
      revenue: 250_000n,
      cost: 0n,
      profit: 250_000n,
    });
    expect(await invoiceBalance(id)).toMatchObject({
      status: "issued",
      outstanding: 275_000n,
    });
  });

  it("never credits more than the invoice when two credit notes race", async () => {
    const jobId = await newJob();
    const invoiceId = await issuedInvoice(jobId);
    // $1,500 + $150 each: either fits alone, both together exceed $2,750.
    const first = await draftCredit(invoiceId, "150000");
    const second = await draftCredit(invoiceId, "150000");
    const results = await Promise.all([issue(first), issue(second)]);
    expect(statuses(results)).toEqual([200, 400]);
    expect(await invoiceBalance(invoiceId)).toMatchObject({
      credited: 165_000n,
      outstanding: 110_000n,
      overpaid: 0n,
    });
    expect(await profitOf(jobId)).toEqual({
      revenue: 100_000n,
      cost: 0n,
      profit: 100_000n,
    });
  });

  it("an invoice void and a receipt for it can't both succeed", async () => {
    for (let round = 0; round < 3; round += 1) {
      const jobId = await newJob();
      const invoiceId = await issuedInvoice(jobId);
      const [voided, received] = await Promise.all([
        r().invVoid(
          call("accountant", "POST", { reason: "Issued in error" }),
          one(invoiceId),
        ),
        money(invoiceId, "275000"),
      ]);
      const balance = await invoiceBalance(invoiceId);
      if (voided.status === 200) {
        expect(received.status).toBe(400);
        expect(balance).toMatchObject({ status: "void", received: 0n });
        expect(await db.receiptAllocation.count({ where: { invoiceId } })).toBe(
          0,
        );
        expect((await profitOf(jobId)).revenue).toBe(0n);
      } else {
        expect([voided.status, received.status]).toEqual([409, 201]);
        expect(balance).toMatchObject({
          status: "issued",
          received: 275_000n,
          outstanding: 0n,
        });
        expect((await profitOf(jobId)).revenue).toBe(250_000n);
      }
    }
  });

  it("a bill void and a payment for it can't both succeed", async () => {
    for (let round = 0; round < 3; round += 1) {
      const jobId = await newJob();
      const billId = (
        (await (await recordBill(jobId)).json()) as { id: string }
      ).id;
      const [voided, paid] = await Promise.all([
        r().voidBill(
          call("accountant", "POST", { reason: "Duplicate" }),
          one(billId),
        ),
        payBill(billId, "99000"),
      ]);
      const balance = await billBalance(billId);
      if (voided.status === 200) {
        expect(paid.status).toBe(400);
        expect(balance).toMatchObject({ status: "void", outstanding: 0n });
        expect((await profitOf(jobId)).cost).toBe(0n);
      } else {
        expect([voided.status, paid.status]).toEqual([409, 201]);
        expect(balance).toMatchObject({ paid: 99_000n, outstanding: 0n });
        expect((await profitOf(jobId)).cost).toBe(90_000n);
      }
    }
  });

  it("refuses zero, negative, fractional and huge amounts everywhere, changing nothing", async () => {
    const jobId = await newJob();
    const invoiceId = await issuedInvoice(jobId);
    const billId = ((await (await recordBill(jobId)).json()) as { id: string })
      .id;
    const before = {
      profit: await profitOf(jobId),
      invoice: await invoiceBalance(invoiceId),
      bill: await billBalance(billId),
      receipts: await db.customerReceipt.count({ where: { companyId } }),
      payments: await db.supplierPayment.count({ where: { companyId } }),
      bills: await db.supplierBill.count({ where: { companyId } }),
      invoices: await db.invoice.count({ where: { companyId } }),
      expenses: await db.expense.count({ where: { companyId } }),
    };
    const bad = [0, "0", -100, "-100", 1.5, "1.50", "1e3", "99999999999999"];
    for (const amount of bad) {
      expect((await money(invoiceId, amount)).status, `receipt ${amount}`).toBe(
        400,
      );
      expect(
        (await money(invoiceId, amount, { kind: "refund" })).status,
        `refund ${amount}`,
      ).toBe(400);
      expect((await payBill(billId, amount)).status, `payment ${amount}`).toBe(
        400,
      );
    }
    for (const amount of [-100, "-100", 1.5, "1.50", "99999999999999"]) {
      expect(
        (
          await recordBill(jobId, [
            {
              description: "Bad",
              taxCode: "TAXABLE_10",
              exclusiveCents: amount,
              gstCents: "0",
            },
          ])
        ).status,
        `bill line ${amount}`,
      ).toBe(400);
      expect(
        (
          await r().expense(
            call("manager", "POST", {
              jobId,
              category: "materials",
              description: "Bad",
              supplierName: "Sample Hardware",
              purchasedOn: "2026-07-03",
              priceEntry: "exclusive",
              amountCents: amount,
              taxCode: "TAXABLE_10",
              settlement: "paid_at_purchase",
              paymentMethod: "card",
            }),
            undefined,
          )
        ).status,
        `expense ${amount}`,
      ).toBe(400);
    }
    // Two lines that each fit but together pass the $10bn ceiling.
    expect(
      (
        await recordBill(jobId, [
          {
            description: "Huge",
            taxCode: "GST_FREE",
            exclusiveCents: "999999999999",
            gstCents: "0",
          },
          {
            description: "Huge",
            taxCode: "GST_FREE",
            exclusiveCents: "999999999999",
            gstCents: "0",
          },
        ])
      ).status,
    ).toBe(400);
    for (const price of [1.5, "1.50", "99999999999999"]) {
      const response = await r().invCreate(
        call("accountant", "POST", {
          customerId,
          jobId,
          lines: [{ ...LINE, unitPriceCents: price }],
        }),
        undefined,
      );
      expect(response.status, `invoice line ${price}`).toBe(400);
    }
    expect({
      profit: await profitOf(jobId),
      invoice: await invoiceBalance(invoiceId),
      bill: await billBalance(billId),
      receipts: await db.customerReceipt.count({ where: { companyId } }),
      payments: await db.supplierPayment.count({ where: { companyId } }),
      bills: await db.supplierBill.count({ where: { companyId } }),
      invoices: await db.invoice.count({ where: { companyId } }),
      expenses: await db.expense.count({ where: { companyId } }),
    }).toEqual(before);
  });
});
