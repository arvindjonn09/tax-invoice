import { sydneyToday } from "../../apps/web/src/server/company/gst";
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
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #141: supplier payments settle approved on-account expenses like bills.
// Fixture (docs/GST.md): the $150 + $15 materials purchase with a valid tax
// invoice, recorded on account. Every case checks the expense's supplier
// balance, its cash-basis claim and the job's profit (payments never move it).
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "manager", "accountant", "employee", "outsider"] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let companyId = "";
let otherCompanyId = "";
let customerId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x1410);

type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
let routes: ReturnType<typeof makeRoutes>;
function makeRoutes() {
  const expenses = expenseHandlers(() => db);
  const bills = billHandlers(() => db);
  const payments = supplierPaymentHandlers(() => db);
  return {
    submit: withPolicy("expense.submit_own", expenses.create),
    decide: withPolicy<One>("expense.approve", expenses.decide),
    reverse: withPolicy<One>("expense.approve", expenses.reverse),
    read: withPolicy<One>("expense.read_all", expenses.read),
    bill: withPolicy("bill.write", bills.create),
    pay: withPolicy("payment.write", payments.create),
    payment: withPolicy<One>("payment.read", payments.read),
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
  const own = factory.company(userIds.owner);
  const other = factory.company(userIds.outsider);
  for (const [record, owner] of [
    [own, userIds.owner],
    [other, userIds.outsider],
  ] as const)
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: record });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  companyId = own.id;
  otherCompanyId = other.id;
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

function call(who: Who, body?: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(cookies[who]);
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
        reference: `JOB-141-${jobNumber}`,
        title: `Synthetic job ${jobNumber}`,
        status: "in_progress",
      },
    })
  ).id;
}

/** The fixture materials ($150 + $15) bought on account and approved. */
async function onAccount(
  jobId: string | null,
  supplierName = "Sample Wholesale",
  amountCents = "15000",
) {
  const document = await db.document.create({
    data: {
      companyId,
      kind: "tax_invoice",
      objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
      fileName: "synthetic-tax-invoice.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      sha256: "0".repeat(64),
      createdBy: userIds.manager,
    },
  });
  const submitted = await routes.submit(
    call("manager", {
      jobId,
      category: "materials",
      description: "Synthetic cable and conduit",
      supplierName,
      purchasedOn: "2026-07-01",
      priceEntry: "exclusive",
      amountCents,
      taxCode: "TAXABLE_10",
      settlement: "on_account",
      receiptDocumentId: document.id,
    }),
    undefined,
  );
  expect(submitted.status).toBe(201);
  const { id } = (await submitted.json()) as { id: string };
  const decided = await routes.decide(
    call("manager", { decision: "approve", evidenceVerified: true }),
    one(id),
  );
  expect(decided.status).toBe(200);
  return id;
}

const pay = (
  allocations: Record<string, string>[],
  { key = `key-${randomUUID()}`, paidOn = "2026-07-10" } = {},
) =>
  routes.pay(
    call(
      "accountant",
      {
        paidOn,
        amountCents: allocations
          .reduce((total, a) => total + BigInt(a.amountCents!), 0n)
          .toString(),
        method: "bank_transfer",
        allocations,
      },
      { "idempotency-key": key },
    ),
    undefined,
  );

const balanceOf = async (expenseId: string) =>
  (
    (await (await routes.read(call("manager"), one(expenseId))).json()) as {
      supplierBalance: { paidCents: string; outstandingCents: string } | null;
    }
  ).supplierBalance;

/** Live cash-basis claim on an expense: payments plus void corrections. */
async function cashClaim(expenseId: string) {
  const [allocations, fixes] = await Promise.all([
    db.supplierPaymentExpenseAllocation.aggregate({
      where: { expenseId, payment: { voidedAt: null } },
      _sum: { creditableGstAttributedCents: true },
    }),
    db.supplierPaymentExpenseGstAdjustment.aggregate({
      where: { expenseId },
      _sum: { creditableGstCents: true },
    }),
  ]);
  return (
    (allocations._sum.creditableGstAttributedCents ?? 0n) +
    (fixes._sum.creditableGstCents ?? 0n)
  ).toString();
}

/** R10 job cost and profit (invoice $2,500 ex GST) from approved expenses. */
async function profitOf(jobId: string) {
  const expenses = await db.expense.findMany({
    where: { companyId, jobId, status: "approved" },
    select: { jobCostCents: true },
  });
  const result = jobProfit({
    revenueExclusive: [250_000n],
    jobCosts: expenses.map((row) => row.jobCostCents!),
  });
  return { cost: result.cost.toString(), profit: result.profit.toString() };
}

const reverse = (expenseId: string, settlement: string) =>
  routes.reverse(
    call("manager", { note: "Synthetic correction", settlement }),
    one(expenseId),
  );

describe("paying on-account expenses (#141)", () => {
  it("fixture: $165 owed on account, $100 paid then the rest; profit never moves", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "0",
      outstandingCents: "16500",
    });
    expect(await profitOf(job)).toEqual({ cost: "15000", profit: "235000" });
    const first = await pay([{ expenseId, amountCents: "10000" }]);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      payeeName: "Sample Wholesale",
      allocations: [],
      // round(100 × 15 / 165) = 909 attributed on the cash basis.
      expenseAllocations: [
        {
          expenseId,
          amountCents: "10000",
          creditableGstAttributedCents: "909",
        },
      ],
    });
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "10000",
      outstandingCents: "6500",
    });
    expect((await pay([{ expenseId, amountCents: "6500" }])).status).toBe(201);
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "16500",
      outstandingCents: "0",
    });
    // Fully paid: exactly the $15 claimable GST, once.
    expect(await cashClaim(expenseId)).toBe("1500");
    expect(await profitOf(job)).toEqual({ cost: "15000", profit: "235000" });
  });

  it("refuses overpayment, unpayable expenses, mixing with bills and mixed suppliers", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    expect((await pay([{ expenseId, amountCents: "16501" }])).status).toBe(400);
    // Paid at purchase: nothing is owed on account.
    const paidAtPurchase = await routes.submit(
      call("manager", {
        jobId: job,
        category: "materials",
        description: "Synthetic card purchase",
        supplierName: "Sample Wholesale",
        purchasedOn: "2026-07-01",
        priceEntry: "exclusive",
        amountCents: "1000",
        taxCode: "TAXABLE_10",
        settlement: "paid_at_purchase",
        paymentMethod: "card",
      }),
      undefined,
    );
    const cardId = ((await paidAtPurchase.json()) as { id: string }).id;
    await routes.decide(call("manager", { decision: "approve" }), one(cardId));
    const unpayable = await pay([{ expenseId: cardId, amountCents: "100" }]);
    expect(unpayable.status).toBe(400);
    expect((await unpayable.json()).error).toMatch(/on-account expense/);
    // Bills and expenses go in separate payments.
    const bill = await routes.bill(
      call("accountant", {
        supplierName: "Sample Wholesale",
        supplierGstRegistered: false,
        issuedOn: "2026-07-02",
        lines: [
          {
            description: "Synthetic",
            taxCode: "GST_FREE",
            exclusiveCents: "1000",
            gstCents: "0",
          },
        ],
      }),
      undefined,
    );
    const billId = ((await bill.json()) as { id: string }).id;
    expect(
      (
        await pay([
          { expenseId, amountCents: "100" },
          { billId, amountCents: "100" },
        ])
      ).status,
    ).toBe(400);
    // Each line names a bill or an expense, not both or neither.
    expect(
      (await pay([{ expenseId, billId, amountCents: "100" }])).status,
    ).toBe(400);
    expect((await pay([{ amountCents: "100" }])).status).toBe(400);
    // One supplier per payment.
    const other = await onAccount(job, "Other Sample Supplier");
    expect(
      (
        await pay([
          { expenseId, amountCents: "100" },
          { expenseId: other, amountCents: "100" },
        ])
      ).status,
    ).toBe(400);
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "0",
      outstandingCents: "16500",
    });
    // Two $150 on-account purchases and the $10 card purchase with no
    // evidence held (its $1 GST is cost): $311.
    expect(await profitOf(job)).toEqual({ cost: "31100", profit: "218900" });
  });

  it("concurrent duplicates record one payment; full payments race and one wins", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    const key = `dup-${randomUUID()}`;
    const copies = await Promise.all(
      Array.from({ length: 4 }, () =>
        pay([{ expenseId, amountCents: "5000" }], { key }),
      ),
    );
    for (const response of copies)
      expect([200, 201]).toContain(response.status);
    expect(
      await db.supplierPayment.count({
        where: { companyId, idempotencyKey: key },
      }),
    ).toBe(1);
    const raced = await Promise.all([
      pay([{ expenseId, amountCents: "11500" }]),
      pay([{ expenseId, amountCents: "11500" }]),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 400]);
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "16500",
      outstandingCents: "0",
    });
    expect(await profitOf(job)).toEqual({ cost: "15000", profit: "235000" });
  });

  it("voiding a payment re-opens the balance and corrects the cash claim", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    const first = (await (
      await pay([{ expenseId, amountCents: "10000" }])
    ).json()) as {
      id: string;
    };
    expect((await pay([{ expenseId, amountCents: "6500" }])).status).toBe(201);
    expect(await cashClaim(expenseId)).toBe("1500");
    const voided = await routes.voidPayment(
      call("accountant", { reason: "Synthetic bounced transfer" }),
      one(first.id),
    );
    expect(voided.status).toBe(200);
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "6500",
      outstandingCents: "10000",
    });
    // round(65 × 15 / 165) = 591: what stays paid carries its share only.
    expect(await cashClaim(expenseId)).toBe("591");
    expect(await profitOf(job)).toEqual({ cost: "15000", profit: "235000" });
  });

  it("race, payment first: a paid expense can't then be credited away", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    expect((await pay([{ expenseId, amountCents: "16500" }])).status).toBe(201);
    const credited = await reverse(expenseId, "supplier_credit");
    expect(credited.status).toBe(409);
    expect((await credited.json()).error).toMatch(/void them first/);
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "16500",
      outstandingCents: "0",
    });
    expect(await profitOf(job)).toEqual({ cost: "15000", profit: "235000" });
  });

  it("race, credit first: a credited expense can't then be paid", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    expect((await reverse(expenseId, "supplier_credit")).status).toBe(201);
    expect(await balanceOf(expenseId)).toBeNull();
    expect((await pay([{ expenseId, amountCents: "100" }])).status).toBe(400);
    // The reversal took the cost back out of the job.
    expect(await profitOf(job)).toEqual({ cost: "0", profit: "250000" });
  });

  it("race, concurrent: payment and supplier credit never both succeed", async () => {
    for (let round = 0; round < 3; round += 1) {
      const job = await newJob();
      const expenseId = await onAccount(job);
      const [paid, credited] = await Promise.all([
        pay([{ expenseId, amountCents: "16500" }]),
        reverse(expenseId, "supplier_credit"),
      ]);
      if (paid.status === 201) {
        expect(credited.status).toBe(409);
        expect(await balanceOf(expenseId)).toEqual({
          paidCents: "16500",
          outstandingCents: "0",
        });
        expect(await profitOf(job)).toEqual({
          cost: "15000",
          profit: "235000",
        });
      } else {
        expect(paid.status).toBe(400);
        expect(credited.status).toBe(201);
        expect(await balanceOf(expenseId)).toBeNull();
        expect(await profitOf(job)).toEqual({ cost: "0", profit: "250000" });
      }
    }
  });

  it("a cost-only reversal keeps the supplier balance payable", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    expect((await reverse(expenseId, "none")).status).toBe(201);
    // The cost is gone, but the supplier is still owed.
    expect(await profitOf(job)).toEqual({ cost: "0", profit: "250000" });
    expect(await balanceOf(expenseId)).toEqual({
      paidCents: "0",
      outstandingCents: "16500",
    });
    expect((await pay([{ expenseId, amountCents: "16500" }])).status).toBe(201);
    expect(await balanceOf(expenseId)).toMatchObject({ outstandingCents: "0" });
    // The reversed expense's GST is gone, so paying it claims none.
    expect(await cashClaim(expenseId)).toBe("0");
  });

  it("reversals and corrections wait until payments are voided; payments then claim the corrected GST", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    const first = (await (
      await pay([{ expenseId, amountCents: "1000" }])
    ).json()) as { id: string };
    expect((await reverse(expenseId, "none")).status).toBe(409);
    expect(
      (
        await routes.voidPayment(
          call("accountant", { reason: "Synthetic: re-pay after correction" }),
          one(first.id),
        )
      ).status,
    ).toBe(200);
    expect((await reverse(expenseId, "none")).status).toBe(201);
    // Correct it at 50% business use: creditable $7.50 of the $15 GST.
    const document = await db.document.create({
      data: {
        companyId,
        kind: "tax_invoice",
        objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
        fileName: "synthetic-tax-invoice.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        sha256: "0".repeat(64),
        createdBy: userIds.manager,
      },
    });
    const submitted = await routes.submit(
      call("manager", {
        jobId: job,
        category: "materials",
        description: "Synthetic cable and conduit (corrected)",
        supplierName: "Sample Wholesale",
        purchasedOn: "2026-07-01",
        priceEntry: "exclusive",
        amountCents: "15000",
        taxCode: "TAXABLE_10",
        creditablePercent: "50",
        settlement: "on_account",
        receiptDocumentId: document.id,
        correctsExpenseId: expenseId,
      }),
      undefined,
    );
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    const correction = (await submitted.json()) as { id: string };
    // While the correction is pending, a payment claims nothing...
    // After a void correction (dated today), payments can't be dated earlier.
    const pending = (await (
      await pay([{ expenseId, amountCents: "16500" }], {
        paidOn: sydneyToday(),
      })
    ).json()) as { id: string };
    expect(await cashClaim(expenseId)).toBe("0");
    // ...and the correction can't be approved under it.
    const approve = () =>
      routes.decide(
        call("manager", { decision: "approve", evidenceVerified: true }),
        one(correction.id),
      );
    expect((await approve()).status).toBe(409);
    expect(
      (
        await routes.voidPayment(
          call("accountant", { reason: "Synthetic: approve correction" }),
          one(pending.id),
        )
      ).status,
    ).toBe(200);
    const approved = await approve();
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(
      (
        await pay([{ expenseId, amountCents: "16500" }], {
          paidOn: sydneyToday(),
        })
      ).status,
    ).toBe(201);
    // Paid in full: exactly the corrected claim.
    expect(await cashClaim(expenseId)).toBe("750");
    // The correction itself can't be reversed under the payment...
    expect((await reverse(correction.id, "none")).status).toBe(409);
    // ...and once it is (payment voided first), payments claim nothing.
    const live = await db.supplierPaymentExpenseAllocation.findFirstOrThrow({
      where: { expenseId, payment: { voidedAt: null } },
    });
    expect(
      (
        await routes.voidPayment(
          call("accountant", { reason: "Synthetic: reverse correction" }),
          one(live.paymentId),
        )
      ).status,
    ).toBe(200);
    expect((await reverse(correction.id, "none")).status).toBe(201);
    expect(
      (
        await pay([{ expenseId, amountCents: "16500" }], {
          paidOn: sydneyToday(),
        })
      ).status,
    ).toBe(201);
    expect(await cashClaim(expenseId)).toBe("0");
  });

  it("refuses a payment dated before the purchase, and combining unnamed suppliers", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    const early = await pay([{ expenseId, amountCents: "1000" }], {
      paidOn: "2026-06-30",
    });
    expect(early.status).toBe(400);
    expect(await early.json()).toMatchObject({
      fields: { paidOn: expect.stringMatching(/purchase date/) },
    });
    const a = await onAccount(job, "");
    const b = await onAccount(job, "");
    const both = await pay([
      { expenseId: a, amountCents: "100" },
      { expenseId: b, amountCents: "100" },
    ]);
    expect(both.status).toBe(400);
    expect((await pay([{ expenseId: a, amountCents: "100" }])).status).toBe(
      201,
    );
  });

  it("allocations are append-only and tenant-scoped; only payment.write records", async () => {
    const job = await newJob();
    const expenseId = await onAccount(job);
    const created = (await (
      await pay([{ expenseId, amountCents: "1000" }])
    ).json()) as {
      id: string;
    };
    await expect(
      db.supplierPaymentExpenseAllocation.updateMany({
        where: { paymentId: created.id },
        data: { amountCents: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db.supplierPaymentExpenseAllocation.deleteMany({
        where: { paymentId: created.id },
      }),
    ).rejects.toThrow();
    for (const who of ["manager", "employee"] as const)
      expect(
        (
          await routes.pay(
            call(
              who,
              {
                paidOn: "2026-07-10",
                amountCents: "100",
                method: "cash",
                allocations: [{ expenseId, amountCents: "100" }],
              },
              { "idempotency-key": `key-${randomUUID()}` },
            ),
            undefined,
          )
        ).status,
      ).toBe(403);
    // Another company's expense isn't payable here.
    const theirs = await db.expense.create({
      data: {
        companyId: otherCompanyId,
        category: "materials",
        description: "Theirs",
        supplierName: "Sample Wholesale",
        purchasedOn: new Date("2026-07-01T00:00:00Z"),
        priceEntry: "exclusive",
        enteredAmountCents: 1000n,
        taxCode: "GST_FREE",
        gstRateBasisPoints: 0,
        exclusiveCents: 1000n,
        gstCents: 0n,
        inclusiveCents: 1000n,
        settlement: "on_account",
        status: "approved",
        submittedBy: userIds.outsider,
        decidedBy: userIds.outsider,
        decidedAt: new Date("2026-07-02T00:00:00Z"),
        companyGstRegistered: true,
        evidenceVerified: false,
        hasEvidence: false,
        creditableGstCents: 0n,
        nonCreditableGstCents: 0n,
        jobCostCents: 1000n,
      },
    });
    expect(
      (await pay([{ expenseId: theirs.id, amountCents: "100" }])).status,
    ).toBe(400);
    expect(await balanceOf(expenseId)).toMatchObject({ paidCents: "1000" });
    expect(await profitOf(job)).toEqual({ cost: "15000", profit: "235000" });
  });
});
