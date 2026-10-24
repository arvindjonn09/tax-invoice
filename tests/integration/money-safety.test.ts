import { randomBytes, randomUUID } from "node:crypto";
import { jobProfit } from "../../packages/domain/src/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  billHandlers,
  jobBillCosts,
  supplierPaymentHandlers,
} from "../../apps/web/src/server/bills/handlers";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import { receiptHandlers } from "../../apps/web/src/server/receipts/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #52: money handling under retries, races, bad amounts and corrections.
// Every case checks the balances AND the job's profit. Profit is built from
// the records the way R10 defines it — invoiced revenue ex GST net of issued
// credit notes, minus incurred job cost (ex GST + non-creditable GST) — so
// payments, receipts, refunds and their voids must never move it.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "accountant"] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let companyId = "";
let customerId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x5252);

type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
let routes: ReturnType<typeof makeRoutes>;

function makeRoutes() {
  const invoices = invoiceHandlers(() => db);
  const receipts = receiptHandlers(() => db);
  const bills = billHandlers(() => db);
  const payments = supplierPaymentHandlers(() => db);
  return {
    invCreate: withPolicy("invoice.write", invoices.create),
    invIssue: withPolicy<One>("invoice.issue", invoices.issue),
    invRead: withPolicy<One>("invoice.read", invoices.read),
    invCredit: withPolicy<One>("invoice.issue", invoices.credit),
    invVoid: withPolicy<One>("invoice.issue", invoices.void),
    receive: withPolicy("payment.write", receipts.create),
    voidReceipt: withPolicy<One>("payment.write", receipts.void),
    bill: withPolicy("bill.write", bills.create),
    billRead: withPolicy<One>("bill.read", bills.read),
    voidBill: withPolicy<One>("bill.write", bills.void),
    pay: withPolicy("payment.write", payments.create),
    voidPayment: withPolicy<One>("payment.write", payments.void),
  };
}

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
  routes = makeRoutes();
  for (const key of WHO)
    userIds[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
        name: `Synthetic ${key}`,
        password: PASSWORD,
      })
    ).id;
  const company = factory.company(userIds.owner);
  await db.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, userIds.owner),
    });
  });
  companyId = company.id;
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
  await db.membership.create({
    data: {
      companyId,
      userId: userIds.accountant,
      createdBy: userIds.owner,
      role: "accountant",
    },
  });
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
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
}, 120_000);
afterAll(() => database?.release());

function call(body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(cookies.accountant);
  h.set("origin", ORIGIN);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: h,
  };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/x`, init);
}

let jobNumber = 0;
async function newJob() {
  jobNumber += 1;
  return (
    await db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId,
        number: jobNumber,
        reference: `JOB-52-${jobNumber}`,
        title: `Synthetic job ${jobNumber}`,
        status: "in_progress",
        agreedPriceExclusiveCents: 250_000n,
      },
    })
  ).id;
}

/** An issued taxable invoice on `jobId`: $2,500 ex + $250 GST = $2,750. */
async function issuedInvoice(jobId: string, priceCents = "250000") {
  const draft = await (
    await routes.invCreate(
      call({
        customerId,
        jobId,
        lines: [
          {
            description: "Install",
            quantity: "1",
            unitPriceCents: priceCents,
            taxCode: "TAXABLE_10",
          },
        ],
      }),
      undefined,
    )
  ).json();
  const issued = await routes.invIssue(
    call({ issueDate: "2026-07-01" }),
    one(draft.id),
  );
  expect(issued.status).toBe(200);
  return draft.id as string;
}

/** $50 ex + $5 GST with no document held: its GST is job cost (R5). */
async function smallBill(jobId: string, exclusive = "5000", gst = "500") {
  const response = await routes.bill(
    call({
      jobId,
      supplierName: "Sample Supplies",
      supplierAbn: syntheticAbn("111111111"),
      supplierGstRegistered: true,
      issuedOn: "2026-07-02",
      lines: [
        {
          description: "Fixings",
          taxCode: "TAXABLE_10",
          exclusiveCents: exclusive,
          gstCents: gst,
        },
      ],
    }),
    undefined,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    jobCostCents: string;
    inclusiveCents: string;
  };
}

/** $1,000 ex + $100 GST with no tax invoice held: the GST is job cost. */
async function bigBill(jobId: string) {
  return smallBill(jobId, "100000", "10000");
}

const receive = (
  allocations: { invoiceId: string; amountCents: string }[],
  {
    key = `key-${randomUUID()}`,
    kind = "receipt",
    amount,
  }: { key?: string; kind?: string; amount?: string } = {},
) =>
  routes.receive(
    call(
      {
        customerId,
        kind,
        receivedOn: "2026-07-05",
        amountCents:
          amount ??
          allocations
            .reduce((t, a) => t + BigInt(a.amountCents), 0n)
            .toString(),
        method: "bank_transfer",
        allocations,
      },
      { "idempotency-key": key },
    ),
    undefined,
  );

const pay = (
  allocations: { billId: string; amountCents: string }[],
  {
    key = `key-${randomUUID()}`,
    amount,
  }: { key?: string; amount?: string } = {},
) =>
  routes.pay(
    call(
      {
        paidOn: "2026-07-06",
        amountCents:
          amount ??
          allocations
            .reduce((t, a) => t + BigInt(a.amountCents), 0n)
            .toString(),
        method: "bank_transfer",
        allocations,
      },
      { "idempotency-key": key },
    ),
    undefined,
  );

const invoiceBalance = async (id: string) => {
  const body = (await (await routes.invRead(call(), one(id))).json()) as {
    receivedCents?: string;
    outstandingCents?: string;
  };
  return { received: body.receivedCents, outstanding: body.outstandingCents };
};
const billBalance = async (id: string) => {
  const body = (await (await routes.billRead(call(), one(id))).json()) as {
    paidCents: string;
    outstandingCents: string;
  };
  return { paid: body.paidCents, outstanding: body.outstandingCents };
};

/** R10 job profit from the stored records (GST-exclusive). */
async function profitOf(jobId: string) {
  const invoices = await db.invoice.findMany({
    where: { companyId, jobId, kind: "invoice", status: "issued" },
    select: { id: true, exclusiveCents: true },
  });
  const credits = await db.invoice.findMany({
    where: {
      companyId,
      kind: "credit_note",
      status: "issued",
      creditsId: { in: invoices.map((invoice) => invoice.id) },
    },
    select: { exclusiveCents: true },
  });
  const { incurred } = await jobBillCosts(db, companyId, jobId);
  const result = jobProfit({
    revenueExclusive: [
      ...invoices.map((invoice) => invoice.exclusiveCents),
      ...credits.map((credit) => -credit.exclusiveCents),
    ],
    jobCosts: [incurred],
  });
  return {
    revenue: result.revenue.toString(),
    cost: result.cost.toString(),
    profit: result.profit.toString(),
  };
}

describe("duplicate submissions (idempotency)", () => {
  it("five concurrent copies of one receipt record it once", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    await bigBill(job);
    const before = await profitOf(job);
    const key = `dup-${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        receive([{ invoiceId, amountCents: "100000" }], { key }),
      ),
    );
    const ids = new Set(
      await Promise.all(
        responses.map(async (response) => {
          expect([200, 201]).toContain(response.status);
          return ((await response.json()) as { id: string }).id;
        }),
      ),
    );
    expect(ids.size).toBe(1);
    expect(
      await db.customerReceipt.count({
        where: { companyId, idempotencyKey: key },
      }),
    ).toBe(1);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "100000",
      outstanding: "175000",
    });
    expect(await profitOf(job)).toEqual(before);
    expect(before).toEqual({
      revenue: "250000",
      cost: "110000",
      profit: "140000",
    });
  });

  it("five concurrent copies of one supplier payment record it once", async () => {
    const job = await newJob();
    await issuedInvoice(job);
    const bill = await bigBill(job);
    const before = await profitOf(job);
    const key = `dup-${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        pay([{ billId: bill.id, amountCents: "50000" }], { key }),
      ),
    );
    for (const response of responses)
      expect([200, 201]).toContain(response.status);
    expect(
      await db.supplierPayment.count({
        where: { companyId, idempotencyKey: key },
      }),
    ).toBe(1);
    expect(await billBalance(bill.id)).toEqual({
      paid: "50000",
      outstanding: "60000",
    });
    expect(await profitOf(job)).toEqual(before);
  });

  it("refuses a key reused for a different request, recording nothing new", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    const bill = await bigBill(job);
    const key = `reuse-${randomUUID()}`;
    expect(
      (await receive([{ invoiceId, amountCents: "1000" }], { key })).status,
    ).toBe(201);
    const changed = await receive([{ invoiceId, amountCents: "2000" }], {
      key,
    });
    expect(changed.status).toBeGreaterThanOrEqual(400);
    expect(changed.status).toBeLessThan(500);
    const payKey = `reuse-${randomUUID()}`;
    expect(
      (await pay([{ billId: bill.id, amountCents: "1000" }], { key: payKey }))
        .status,
    ).toBe(201);
    const payChanged = await pay([{ billId: bill.id, amountCents: "2000" }], {
      key: payKey,
    });
    expect(payChanged.status).toBeGreaterThanOrEqual(400);
    expect(payChanged.status).toBeLessThan(500);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "1000",
      outstanding: "274000",
    });
    expect(await billBalance(bill.id)).toEqual({
      paid: "1000",
      outstanding: "109000",
    });
  });

  it("refuses a missing or malformed idempotency key", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    for (const key of ["", "short", "has spaces in it", "x".repeat(201)])
      expect(
        (await receive([{ invoiceId, amountCents: "100" }], { key })).status,
      ).toBe(400);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "0",
      outstanding: "275000",
    });
  });
});

describe("races between different requests", () => {
  it("two full receipts racing for one invoice: exactly one wins", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    const before = await profitOf(job);
    const responses = await Promise.all([
      receive([{ invoiceId, amountCents: "275000" }]),
      receive([{ invoiceId, amountCents: "275000" }]),
      receive([{ invoiceId, amountCents: "275000" }]),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(
      statuses
        .filter((status) => status !== 201)
        .every((s) => s >= 400 && s < 500),
    ).toBe(true);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "275000",
      outstanding: "0",
    });
    expect(await profitOf(job)).toEqual(before);
  });

  it("two full payments racing for one bill: exactly one wins", async () => {
    const job = await newJob();
    const bill = await bigBill(job);
    const before = await profitOf(job);
    const responses = await Promise.all([
      pay([{ billId: bill.id, amountCents: "110000" }]),
      pay([{ billId: bill.id, amountCents: "110000" }]),
      pay([{ billId: bill.id, amountCents: "110000" }]),
    ]);
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(await billBalance(bill.id)).toEqual({
      paid: "110000",
      outstanding: "0",
    });
    expect(await profitOf(job)).toEqual(before);
  });

  it("a payment racing the bill's void never leaves money on a void bill", async () => {
    const job = await newJob();
    const bill = await bigBill(job);
    const [paid, voided] = await Promise.all([
      pay([{ billId: bill.id, amountCents: "110000" }]),
      routes.voidBill(call({ reason: "Synthetic duplicate" }), one(bill.id)),
    ]);
    const live = await db.supplierPaymentAllocation.count({
      where: { companyId, billId: bill.id, payment: { voidedAt: null } },
    });
    const isVoid =
      (await db.supplierBill.findUniqueOrThrow({ where: { id: bill.id } }))
        .voidedAt !== null;
    // Either the payment landed first (and the void was refused), or the void
    // landed first (and the payment was refused) — never both.
    expect([paid.status === 201, voided.status === 200]).not.toEqual([
      true,
      true,
    ]);
    expect(live > 0 && isVoid).toBe(false);
    expect((await profitOf(job)).cost).toBe(isVoid ? "0" : "110000");
  });
});

describe("amounts", () => {
  it("refuses zero, negative, fractional and huge amounts without recording anything", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    const bill = await bigBill(job);
    const before = await profitOf(job);
    for (const amount of [
      "0",
      "-100",
      "1.5",
      "1e5",
      "10000000000001",
      "99999999999999",
    ]) {
      expect(
        (await receive([{ invoiceId, amountCents: amount }], { amount }))
          .status,
      ).toBe(400);
      expect(
        (await pay([{ billId: bill.id, amountCents: amount }], { amount }))
          .status,
      ).toBe(400);
    }
    // Totals that don't match their allocations.
    expect(
      (await receive([{ invoiceId, amountCents: "100" }], { amount: "101" }))
        .status,
    ).toBe(400);
    expect(
      (await pay([{ billId: bill.id, amountCents: "100" }], { amount: "99" }))
        .status,
    ).toBe(400);
    // No allocations, or the same document twice.
    expect((await receive([], { amount: "100" })).status).toBe(400);
    expect(
      (
        await pay([
          { billId: bill.id, amountCents: "100" },
          { billId: bill.id, amountCents: "100" },
        ])
      ).status,
    ).toBe(400);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "0",
      outstanding: "275000",
    });
    expect(await billBalance(bill.id)).toEqual({
      paid: "0",
      outstanding: "110000",
    });
    expect(
      await db.customerReceipt.count({
        where: { companyId, allocations: { some: { invoiceId } } },
      }),
    ).toBe(0);
    expect(await profitOf(job)).toEqual(before);
  });

  it("refuses bill lines with negative amounts or GST that isn't 10%", async () => {
    const job = await newJob();
    for (const [exclusive, gst] of [
      ["-100", "0"],
      ["10000", "-10"],
      ["10000", "2000"],
    ] as const) {
      const response = await routes.bill(
        call({
          jobId: job,
          supplierName: "Sample Supplies",
          supplierAbn: syntheticAbn("111111111"),
          supplierGstRegistered: true,
          issuedOn: "2026-07-02",
          lines: [
            {
              description: "Fixings",
              taxCode: "TAXABLE_10",
              exclusiveCents: exclusive,
              gstCents: gst,
            },
          ],
        }),
        undefined,
      );
      expect(response.status).toBe(400);
    }
    expect(await profitOf(job)).toEqual({
      revenue: "0",
      cost: "0",
      profit: "0",
    });
  });

  it("refuses overpayment of an invoice or a bill, even by one cent", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    const bill = await bigBill(job);
    expect((await receive([{ invoiceId, amountCents: "275001" }])).status).toBe(
      400,
    );
    expect(
      (await pay([{ billId: bill.id, amountCents: "110001" }])).status,
    ).toBe(400);
    expect((await receive([{ invoiceId, amountCents: "275000" }])).status).toBe(
      201,
    );
    expect(
      (await pay([{ billId: bill.id, amountCents: "110000" }])).status,
    ).toBe(201);
    expect((await receive([{ invoiceId, amountCents: "1" }])).status).toBe(400);
    expect((await pay([{ billId: bill.id, amountCents: "1" }])).status).toBe(
      400,
    );
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "275000",
      outstanding: "0",
    });
    expect(await billBalance(bill.id)).toEqual({
      paid: "110000",
      outstanding: "0",
    });
    expect(await profitOf(job)).toEqual({
      revenue: "250000",
      cost: "110000",
      profit: "140000",
    });
  });
});

describe("corrections", () => {
  it("voiding a receipt restores the balance and never moves profit", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    await smallBill(job);
    const before = await profitOf(job);
    expect(before).toEqual({
      revenue: "250000",
      cost: "5500",
      profit: "244500",
    });
    const receipt = (await (
      await receive([{ invoiceId, amountCents: "200000" }])
    ).json()) as { id: string };
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "200000",
      outstanding: "75000",
    });
    const voided = await routes.voidReceipt(
      call({ reason: "Synthetic bounced transfer" }),
      one(receipt.id),
    );
    expect(voided.status).toBe(200);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "0",
      outstanding: "275000",
    });
    // Voiding twice is refused; the record stays as it was.
    expect(
      (await routes.voidReceipt(call({ reason: "again" }), one(receipt.id)))
        .status,
    ).toBe(409);
    expect(await profitOf(job)).toEqual(before);
  });

  it("an invoice with a live receipt can't be voided; once the receipt is void it can", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    const receipt = (await (
      await receive([{ invoiceId, amountCents: "1000" }])
    ).json()) as { id: string };
    const refused = await routes.invVoid(
      call({ reason: "Synthetic mistake" }),
      one(invoiceId),
    );
    expect(refused.status).toBe(409);
    expect(await profitOf(job)).toEqual({
      revenue: "250000",
      cost: "0",
      profit: "250000",
    });
    expect(
      (await routes.voidReceipt(call({ reason: "Synthetic" }), one(receipt.id)))
        .status,
    ).toBe(200);
    expect(
      (
        await routes.invVoid(
          call({ reason: "Synthetic mistake" }),
          one(invoiceId),
        )
      ).status,
    ).toBe(200);
    // A void invoice is no longer revenue.
    expect(await profitOf(job)).toEqual({
      revenue: "0",
      cost: "0",
      profit: "0",
    });
  });

  it("voiding a supplier payment makes the bill owing again; voiding the bill removes its cost", async () => {
    const job = await newJob();
    await issuedInvoice(job);
    const bill = await bigBill(job);
    const payment = (await (
      await pay([{ billId: bill.id, amountCents: "110000" }])
    ).json()) as { id: string };
    expect((await profitOf(job)).profit).toBe("140000");
    // A paid bill can't be voided while its payment stands.
    expect(
      (await routes.voidBill(call({ reason: "Synthetic" }), one(bill.id)))
        .status,
    ).toBe(409);
    expect(
      (
        await routes.voidPayment(
          call({ reason: "Synthetic reversal" }),
          one(payment.id),
        )
      ).status,
    ).toBe(200);
    expect(await billBalance(bill.id)).toEqual({
      paid: "0",
      outstanding: "110000",
    });
    expect((await profitOf(job)).profit).toBe("140000");
    expect(
      (
        await routes.voidBill(
          call({ reason: "Synthetic duplicate" }),
          one(bill.id),
        )
      ).status,
    ).toBe(200);
    expect(await billBalance(bill.id)).toEqual({ paid: "0", outstanding: "0" });
    expect(await profitOf(job)).toEqual({
      revenue: "250000",
      cost: "0",
      profit: "250000",
    });
  });

  it("a credit note lowers both what's owed and revenue; receipts can't exceed the rest", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    await bigBill(job);
    // $1,000 ex + $100 GST credit.
    const credit = await (
      await routes.invCredit(
        call({
          lines: [
            {
              description: "Synthetic discount",
              quantity: "1",
              unitPriceCents: "100000",
              taxCode: "TAXABLE_10",
            },
          ],
        }),
        one(invoiceId),
      )
    ).json();
    expect((await routes.invIssue(call({}), one(credit.id))).status).toBe(200);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "0",
      outstanding: "165000",
    });
    expect(await profitOf(job)).toEqual({
      revenue: "150000",
      cost: "110000",
      profit: "40000",
    });
    expect((await receive([{ invoiceId, amountCents: "165001" }])).status).toBe(
      400,
    );
    expect((await receive([{ invoiceId, amountCents: "165000" }])).status).toBe(
      201,
    );
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "165000",
      outstanding: "0",
    });
    expect(await profitOf(job)).toEqual({
      revenue: "150000",
      cost: "110000",
      profit: "40000",
    });
  });

  it("refunds return at most what was received and never move profit", async () => {
    const job = await newJob();
    const invoiceId = await issuedInvoice(job);
    await smallBill(job);
    const before = await profitOf(job);
    expect((await receive([{ invoiceId, amountCents: "100000" }])).status).toBe(
      201,
    );
    expect(
      (
        await receive([{ invoiceId, amountCents: "100001" }], {
          kind: "refund",
        })
      ).status,
    ).toBe(400);
    const refund = await receive([{ invoiceId, amountCents: "40000" }], {
      kind: "refund",
    });
    expect(refund.status).toBe(201);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "60000",
      outstanding: "215000",
    });
    expect(await profitOf(job)).toEqual(before);
    // Voiding the refund puts the money back as received.
    const refundId = ((await refund.json()) as { id: string }).id;
    expect(
      (await routes.voidReceipt(call({ reason: "Synthetic" }), one(refundId)))
        .status,
    ).toBe(200);
    expect(await invoiceBalance(invoiceId)).toEqual({
      received: "100000",
      outstanding: "175000",
    });
    expect(await profitOf(job)).toEqual(before);
  });
});
