import { randomBytes, randomUUID } from "node:crypto";
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
import { expenseHandlers } from "../../apps/web/src/server/expenses/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #46: supplier and contractor bills, and idempotent supplier payments.
// Fixture (docs/GST.md): $990 contractor bill, $400 paid → $590 owing; job
// cost and profit unchanged by payment.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "manager", "accountant", "employee", "outsider"] as const;
type Who = (typeof WHO)[number];
const CONTRACTOR_ABN = syntheticAbn("464646464");
const SUPPLIER_ABN = syntheticAbn("464646470");

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let bills: ReturnType<typeof billHandlers>;
let payments: ReturnType<typeof supplierPaymentHandlers>;
let expenses: ReturnType<typeof expenseHandlers>;
let companyId = "";
let otherCompanyId = "";
let customerId = "";
let contractorId = "";
let outsiderBillId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x4646);

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
  bills = billHandlers(() => db);
  payments = supplierPaymentHandlers(() => db);
  expenses = expenseHandlers(() => db);
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
  const other = factory.company(userIds.outsider);
  for (const [record, owner] of [
    [own, userIds.owner],
    [other, userIds.outsider],
  ] as const) {
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: record });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  }
  companyId = own.id;
  otherCompanyId = other.id;
  // Registered (cash basis) from 1 July 2025; earlier bills are unregistered.
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
  contractorId = (
    await db.contractor.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        name: "Sample Sparks",
        abn: CONTRACTOR_ABN,
        gstRegistered: true,
      },
    })
  ).id;
  const theirs = await db.contractor.create({
    data: {
      companyId: otherCompanyId,
      createdBy: userIds.outsider,
      name: "Their Supplier",
      gstRegistered: false,
    },
  });
  outsiderBillId = (
    await db.supplierBill.create({
      data: {
        companyId: otherCompanyId,
        contractorId: theirs.id,
        supplierName: theirs.name,
        supplierGstRegistered: false,
        issuedOn: new Date("2026-07-01T00:00:00Z"),
        hasEvidence: false,
        companyGstRegistered: false,
        exclusiveCents: 10_000n,
        gstCents: 0n,
        inclusiveCents: 10_000n,
        creditableGstCents: 0n,
        nonCreditableGstCents: 0n,
        jobCostCents: 10_000n,
        createdBy: userIds.outsider,
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
}, 120_000);
afterAll(() => database?.release());

function call(
  who: Who,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
  path = "/api/x",
) {
  const h = new Headers(cookies[who]);
  h.set("origin", ORIGIN);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  const init: RequestInit = { method, headers: h };
  if (body !== undefined) {
    h.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}${path}`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  create: withPolicy("bill.write", bills.create),
  read: withPolicy<One>("bill.read", bills.read),
  list: withPolicy("bill.read", bills.list),
  voidBill: withPolicy<One>("bill.write", bills.void),
  pay: withPolicy("payment.write", payments.create),
  payment: withPolicy<One>("payment.read", payments.read),
  payments: withPolicy("payment.read", payments.list),
  voidPayment: withPolicy<One>("payment.write", payments.void),
  submitExpense: withPolicy("expense.submit_own", expenses.create),
});

type Bill = {
  id: string;
  status: string;
  jobId: string | null;
  offerId: string | null;
  supplierName: string;
  inclusiveCents: string;
  creditableGstCents: string;
  nonCreditableGstCents: string;
  jobCostCents: string;
  paidCents: string;
  outstandingCents: string;
  hasEvidence: boolean;
  companyGstRegistered: boolean;
  payments: { paymentId: string; amountCents: string; void: boolean }[];
};
type Payment = {
  id: string;
  amountCents: string;
  payeeName: string;
  allocations: {
    billId: string;
    amountCents: string;
    creditableGstAttributedCents: string;
  }[];
};

let jobNumber = 0;
async function newJob() {
  jobNumber += 1;
  return db.job.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      customerId,
      number: jobNumber,
      reference: `JOB-46-${jobNumber}`,
      title: `Synthetic billed work ${jobNumber}`,
      agreedPriceExclusiveCents: 250_000n,
    },
  });
}

/** An accepted $900 ex GST fixed offer: commits $900 of job cost. */
async function acceptedOffer(jobId: string) {
  const offer = await db.contractorOffer.create({
    data: {
      companyId,
      jobId,
      contractorId,
      scope: "Synthetic wiring",
      rateType: "fixed",
      rateExclusiveCents: 90_000n,
      taxCode: "TAXABLE_10",
      status: "accepted",
      respondedAt: new Date(),
      respondedBy: userIds.owner,
      createdBy: userIds.owner,
    },
  });
  await db.contractorAcceptance.create({
    data: {
      companyId,
      offerId: offer.id,
      jobId,
      contractorId,
      rateType: "fixed",
      rateExclusiveCents: 90_000n,
      taxCode: "TAXABLE_10",
      gstRateBasisPoints: 1000,
      exclusiveCents: 90_000n,
      gstCents: 9_000n,
      inclusiveCents: 99_000n,
      contractorGstRegistered: true,
      companyGstRegistered: true,
      committedCostCents: 90_000n,
      acceptedBy: userIds.owner,
    },
  });
  return offer.id;
}

async function document(kind: "tax_invoice" | "receipt" = "tax_invoice") {
  return (
    await db.document.create({
      data: {
        companyId,
        kind,
        objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
        fileName: "synthetic-tax-invoice.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        sha256: "a".repeat(64),
        createdBy: userIds.accountant,
      },
    })
  ).id;
}

const SUBCONTRACT_LINE = {
  description: "Synthetic wiring per accepted offer",
  taxCode: "TAXABLE_10",
  exclusiveCents: "90000",
  gstCents: "9000",
};

async function record(body: Record<string, unknown>, who: Who = "accountant") {
  const response = await r().create(call(who, "POST", body), undefined);
  return {
    status: response.status,
    body: (await response.json()) as Bill & {
      error?: string;
      fields?: Record<string, string>;
    },
  };
}

async function pay(
  body: Record<string, unknown>,
  key: string = randomUUID(),
  who: Who = "accountant",
) {
  const response = await r().pay(
    call(who, "POST", body, { "idempotency-key": key }),
    undefined,
  );
  return {
    status: response.status,
    replayed: response.headers.get("idempotent-replayed") === "true",
    body: (await response.json()) as Payment & {
      error?: string;
      fields?: Record<string, string>;
    },
  };
}

async function readBill(id: string) {
  return (await (
    await r().read(call("accountant", "GET"), one(id))
  ).json()) as Bill;
}

async function jobTotals(jobId: string) {
  const response = await r().list(
    call("accountant", "GET", undefined, {}, `/api/bills?jobId=${jobId}`),
    undefined,
  );
  return (
    (await response.json()) as {
      job: { incurredCostCents: string; committedCostCents: string };
    }
  ).job;
}

describe("supplier bills (#46)", () => {
  it("fixture: $990 contractor bill, $400 paid → $590 owing; job cost unchanged by payment", async () => {
    const job = await newJob();
    const offerId = await acceptedOffer(job.id);
    expect(await jobTotals(job.id)).toEqual({
      incurredCostCents: "0",
      committedCostCents: "90000",
    });
    const recorded = await record({
      contractorId,
      offerId,
      supplierReference: "INV-990",
      issuedOn: "2026-07-15",
      lines: [SUBCONTRACT_LINE],
      documentId: await document(),
      evidenceVerified: true,
    });
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({
      jobId: job.id,
      offerId,
      supplierName: "Sample Sparks",
      inclusiveCents: "99000",
      creditableGstCents: "9000",
      nonCreditableGstCents: "0",
      jobCostCents: "90000",
      hasEvidence: true,
      companyGstRegistered: true,
      outstandingCents: "99000",
      status: "open",
    });
    // Billed: the commitment is released; incurred and committed never double.
    const billed = await jobTotals(job.id);
    expect(billed).toEqual({
      incurredCostCents: "90000",
      committedCostCents: "0",
    });

    const paid = await pay({
      paidOn: "2026-07-20",
      amountCents: "40000",
      method: "bank_transfer",
      allocations: [{ billId: recorded.body.id, amountCents: "40000" }],
    });
    expect(paid.status).toBe(201);
    expect(paid.body.payeeName).toBe("Sample Sparks");
    const after = await readBill(recorded.body.id);
    expect(after).toMatchObject({
      paidCents: "40000",
      outstandingCents: "59000",
      jobCostCents: "90000",
      status: "open",
    });
    expect(await jobTotals(job.id)).toEqual(billed);
    expect(await jobBillCosts(db, companyId, job.id)).toEqual({
      incurred: 90_000n,
      committed: 0n,
    });
    // Profit = $2,500 revenue − incurred cost; the payment changed neither.
    const profit = 250_000n - BigInt(billed.incurredCostCents);
    expect(
      250_000n - (await jobBillCosts(db, companyId, job.id)).incurred,
    ).toBe(profit);
    expect(
      await db.auditEvent.count({
        where: {
          companyId,
          action: { in: ["bill.recorded", "supplier_payment.recorded"] },
          targetId: { in: [recorded.body.id, paid.body.id] },
        },
      }),
    ).toBe(2);
  });

  it("not-registered company: no GST claimable; GST on a bill is cost", async () => {
    const job = await newJob();
    // Before registration (1 July 2025): the supplier's GST can't be claimed.
    const early = await record({
      contractorId,
      jobId: job.id,
      issuedOn: "2025-06-30",
      lines: [SUBCONTRACT_LINE],
      documentId: await document(),
      evidenceVerified: true,
    });
    expect(early.status).toBe(201);
    expect(early.body).toMatchObject({
      companyGstRegistered: false,
      creditableGstCents: "0",
      nonCreditableGstCents: "9000",
      jobCostCents: "99000",
    });
    // An unregistered supplier charges no GST: $400 of $900 leaves $500.
    const plain = await record({
      supplierName: "Sample Hardware",
      supplierGstRegistered: false,
      jobId: job.id,
      issuedOn: "2026-07-15",
      lines: [
        {
          description: "Synthetic timber",
          taxCode: "OUT_OF_SCOPE",
          exclusiveCents: "90000",
          gstCents: "0",
        },
      ],
    });
    expect(plain.status).toBe(201);
    const paid = await pay({
      paidOn: "2026-07-20",
      amountCents: "40000",
      method: "cash",
      allocations: [{ billId: plain.body.id, amountCents: "40000" }],
    });
    expect(paid.status).toBe(201);
    expect((await readBill(plain.body.id)).outstandingCents).toBe("50000");
  });

  it("GST is creditable only with verified evidence, limited to the business share", async () => {
    const job = await newJob();
    const base = {
      contractorId,
      jobId: job.id,
      issuedOn: "2026-07-15",
      lines: [SUBCONTRACT_LINE],
    };
    const noDocument = await record(base);
    const unverified = await record({ ...base, documentId: await document() });
    const receipt = await record({
      ...base,
      documentId: await document("receipt"),
      evidenceVerified: true,
    });
    for (const result of [noDocument, unverified, receipt]) {
      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        hasEvidence: false,
        creditableGstCents: "0",
        nonCreditableGstCents: "9000",
        jobCostCents: "99000",
      });
    }
    const half = await record({
      ...base,
      documentId: await document(),
      evidenceVerified: true,
      creditableBasisPoints: 5000,
      creditableReason: "Half private use",
    });
    expect(half.body).toMatchObject({
      creditableGstCents: "4500",
      nonCreditableGstCents: "4500",
      jobCostCents: "94500",
    });
  });

  it("validates bills", async () => {
    const job = await newJob();
    const otherJob = await newJob();
    const offerId = await acceptedOffer(job.id);
    const ok = {
      supplierName: "Sample Supplies",
      supplierAbn: SUPPLIER_ABN,
      supplierGstRegistered: true,
      jobId: job.id,
      issuedOn: "2026-07-15",
      lines: [SUBCONTRACT_LINE],
    };
    const used = await document();
    // A document already attached to another bill can't be reused.
    expect((await record({ ...ok, documentId: used })).status).toBe(201);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ok, issuedOn: "2999-01-01" }, "issuedOn"],
      [{ ...ok, dueOn: "2026-07-14" }, "dueOn"],
      [{ ...ok, creditableBasisPoints: 5000 }, "creditableReason"],
      [{ ...ok, evidenceVerified: true }, "documentId"],
      [{ ...ok, supplierAbn: null }, "supplierAbn"],
      [{ ...ok, supplierName: null }, "supplierName"],
      [{ ...ok, supplierGstRegistered: undefined }, "supplierGstRegistered"],
      [
        {
          ...ok,
          supplierGstRegistered: false,
          supplierAbn: null,
        },
        "lines.0",
      ],
      [
        { ...ok, lines: [{ ...SUBCONTRACT_LINE, gstCents: "9002" }] },
        "lines.0",
      ],
      [
        {
          ...ok,
          lines: [{ ...SUBCONTRACT_LINE, taxCode: "GST_FREE" }],
        },
        "lines.0",
      ],
      [
        {
          ...ok,
          lines: [{ ...SUBCONTRACT_LINE, exclusiveCents: "0", gstCents: "0" }],
        },
        "lines",
      ],
      [{ ...ok, offerId }, "contractorId"],
      [
        {
          contractorId,
          offerId,
          jobId: otherJob.id,
          issuedOn: "2026-07-15",
          lines: [SUBCONTRACT_LINE],
        },
        "jobId",
      ],
      [
        {
          contractorId,
          offerId: randomUUID(),
          issuedOn: "2026-07-15",
          lines: [SUBCONTRACT_LINE],
        },
        "offerId",
      ],
      [{ ...ok, jobId: randomUUID() }, "jobId"],
      [{ ...ok, documentId: used }, "documentId"],
      [{ ...ok, documentId: randomUUID() }, "documentId"],
      [{ ...ok, contractorId: randomUUID() }, "contractorId"],
    ];
    for (const [body, field] of cases) {
      const result = await record(body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(result.body.fields ?? {}), field).toContain(field);
    }
    expect((await record({ ...ok, lines: [] })).status).toBe(400);
    // The same supplier invoice twice is refused while the first is live.
    const first = await record({ ...ok, supplierReference: "SS-1" });
    expect(first.status).toBe(201);
    const again = await record({ ...ok, supplierReference: "SS-1" });
    expect(again.status).toBe(409);
    expect(again.body.fields).toHaveProperty("supplierReference");
    // Name and reference compare case-insensitively.
    expect(
      (
        await record({
          ...ok,
          supplierName: "sample SUPPLIES",
          supplierReference: "ss-1",
        })
      ).status,
    ).toBe(409);
    // Concurrent copies record exactly one bill (the database decides).
    for (const reference of ["SS-2", "SS-3", "SS-4"]) {
      const racing = await Promise.all([
        record({ ...ok, supplierReference: reference }),
        record({
          ...ok,
          supplierName: "SAMPLE SUPPLIES",
          supplierReference: reference.toLowerCase(),
        }),
      ]);
      expect(racing.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(
        racing.find((result) => result.status === 409)!.body.fields,
      ).toHaveProperty("supplierReference");
    }
    // Voiding the bill frees its reference.
    expect(
      (
        await r().voidBill(
          call("accountant", "POST", { reason: "Entered twice" }),
          one(first.body.id),
        )
      ).status,
    ).toBe(200);
    expect((await record({ ...ok, supplierReference: "SS-1" })).status).toBe(
      201,
    );
    // A supplier's figures are kept as issued: one cent of rounding is fine.
    const rounded = await record({
      ...ok,
      lines: [
        {
          description: "Rounded by the supplier",
          taxCode: "TAXABLE_10",
          exclusiveCents: "1005",
          gstCents: "101",
        },
      ],
    });
    expect(rounded.status).toBe(201);
    expect(rounded.body.inclusiveCents).toBe("1106");
  });

  it("is office-only to read and owner/accountant-only to record, per company", async () => {
    const created = await record({
      supplierName: "Sample Roles Supplier",
      supplierGstRegistered: false,
      issuedOn: "2026-07-15",
      lines: [
        {
          description: "Synthetic",
          taxCode: "GST_FREE",
          exclusiveCents: "500",
          gstCents: "0",
        },
      ],
    });
    expect(created.status).toBe(201);
    const body = {
      supplierName: "X",
      supplierGstRegistered: false,
      issuedOn: "2026-07-15",
      lines: [
        {
          description: "X",
          taxCode: "GST_FREE",
          exclusiveCents: "1",
          gstCents: "0",
        },
      ],
    };
    expect((await record(body, "owner")).status).toBe(201);
    for (const who of ["manager", "employee"] as const)
      expect((await record(body, who)).status, who).toBe(403);
    expect(
      (await r().read(call("manager", "GET"), one(created.body.id))).status,
    ).toBe(200);
    expect(
      (await r().read(call("employee", "GET"), one(created.body.id))).status,
    ).toBe(403);
    // Another company's bill is not found, by read, void or payment.
    expect(
      (await r().read(call("accountant", "GET"), one(outsiderBillId))).status,
    ).toBe(404);
    expect(
      (
        await r().voidBill(
          call("accountant", "POST", { reason: "x" }),
          one(outsiderBillId),
        )
      ).status,
    ).toBe(404);
    const foreign = await pay({
      paidOn: "2026-07-20",
      amountCents: "100",
      method: "cash",
      allocations: [{ billId: outsiderBillId, amountCents: "100" }],
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.fields).toHaveProperty("allocations.0");
    for (const who of ["manager", "employee"] as const)
      expect(
        (
          await pay(
            {
              paidOn: "2026-07-20",
              amountCents: "100",
              method: "cash",
              allocations: [{ billId: created.body.id, amountCents: "100" }],
            },
            randomUUID(),
            who,
          )
        ).status,
        who,
      ).toBe(403);
    const list = (await (
      await r().list(
        call("accountant", "GET", undefined, {}, "/api/bills?status=all"),
        undefined,
      )
    ).json()) as { bills: Bill[] };
    expect(list.bills.map((bill) => bill.id)).not.toContain(outsiderBillId);
  });
});

describe("supplier payments (#46)", () => {
  async function openBill(inclusive = 99_000n, name = "Sample Sparks") {
    const recorded = await record(
      name === "Sample Sparks"
        ? {
            contractorId,
            issuedOn: "2026-07-15",
            lines: [
              {
                description: "Synthetic",
                taxCode: "TAXABLE_10",
                exclusiveCents: ((inclusive * 10n) / 11n).toString(),
                gstCents: (inclusive - (inclusive * 10n) / 11n).toString(),
              },
            ],
            documentId: await document(),
            evidenceVerified: true,
          }
        : {
            supplierName: name,
            supplierGstRegistered: false,
            issuedOn: "2026-07-15",
            lines: [
              {
                description: "Synthetic",
                taxCode: "GST_FREE",
                exclusiveCents: inclusive.toString(),
                gstCents: "0",
              },
            ],
          },
    );
    expect(recorded.status).toBe(201);
    return recorded.body;
  }
  const payment = (billId: string, amount: string) => ({
    paidOn: "2026-07-20",
    amountCents: amount,
    method: "bank_transfer",
    allocations: [{ billId, amountCents: amount }],
  });

  it("creates one payment for concurrent duplicate submissions", async () => {
    const bill = await openBill();
    const key = `dup-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pay(payment(bill.id, "40000"), key)),
    );
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(5);
    expect(
      await db.supplierPayment.count({
        where: { companyId, idempotencyKey: key },
      }),
    ).toBe(1);
    expect((await readBill(bill.id)).outstandingCents).toBe("59000");
    // The same key with a different request is refused, not replayed.
    const changed = await pay(payment(bill.id, "100"), key);
    expect(changed.status).toBe(409);
    expect((await readBill(bill.id)).outstandingCents).toBe("59000");
  });

  it("rejects overpayment, including two different payments racing for the balance", async () => {
    const bill = await openBill();
    const over = await pay(payment(bill.id, "99001"));
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/overpayment/);
    const racing = await Promise.all([
      pay(payment(bill.id, "60000")),
      pay(payment(bill.id, "60000")),
    ]);
    expect(racing.map((result) => result.status).sort()).toEqual([201, 400]);
    expect((await readBill(bill.id)).outstandingCents).toBe("39000");
    // Paying exactly what's left settles it; nothing more can be paid.
    expect((await pay(payment(bill.id, "39000"))).status).toBe(201);
    const settled = await readBill(bill.id);
    expect(settled).toMatchObject({ outstandingCents: "0", status: "paid" });
    expect((await pay(payment(bill.id, "1"))).status).toBe(400);
  });

  it("validates payments and pays one supplier at a time", async () => {
    const a = await openBill(10_000n, "Sample Alpha");
    const b = await openBill(10_000n, "Sample Beta");
    const missingKey = await r().pay(
      call("accountant", "POST", payment(a.id, "100")),
      undefined,
    );
    expect(missingKey.status).toBe(400);
    expect(
      (await pay({ ...payment(a.id, "100"), paidOn: "2999-01-01" })).status,
    ).toBe(400);
    const split = await pay({
      paidOn: "2026-07-20",
      amountCents: "200",
      method: "cash",
      allocations: [
        { billId: a.id, amountCents: "100" },
        { billId: b.id, amountCents: "100" },
      ],
    });
    expect(split.status).toBe(400);
    expect(split.body.error).toMatch(/one supplier/);
    const mismatch = await pay({
      ...payment(a.id, "100"),
      amountCents: "150",
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.fields).toHaveProperty("allocations");
  });

  it("attributes the bill's creditable GST across partial payments exactly once", async () => {
    const bill = await openBill();
    const ids: string[] = [];
    for (const amount of ["40000", "33333", "25667"])
      ids.push((await pay(payment(bill.id, amount))).body.id);
    const allocations = await db.supplierPaymentAllocation.findMany({
      where: { companyId, billId: bill.id },
    });
    expect(
      allocations.reduce(
        (total, row) => total + row.creditableGstAttributedCents,
        0n,
      ),
    ).toBe(9_000n);
    expect(ids).toHaveLength(3);
  });

  it("voiding a payment corrects the bill's credit at once, without editing history", async () => {
    // $990 bill with $90 creditable GST (1/11): 5c → 0, 1c → 1, the rest.
    const bill = await openBill();
    const paid: Payment[] = [];
    for (const amount of ["5", "1", "98994"])
      paid.push((await pay(payment(bill.id, amount))).body);
    expect(
      paid.map((p) => p.allocations[0]!.creditableGstAttributedCents),
    ).toEqual(["0", "1", "8999"]);
    const liveCredit = async () => {
      const [allocations, adjustments] = await Promise.all([
        db.supplierPaymentAllocation.aggregate({
          where: { billId: bill.id, payment: { voidedAt: null } },
          _sum: { creditableGstAttributedCents: true },
        }),
        db.supplierPaymentGstAdjustment.aggregate({
          where: { billId: bill.id },
          _sum: { creditableGstCents: true },
        }),
      ]);
      return (
        (allocations._sum.creditableGstAttributedCents ?? 0n) +
        (adjustments._sum.creditableGstCents ?? 0n)
      );
    };
    expect(
      (
        await r().voidPayment(
          call("accountant", "POST", { reason: "Bounced" }),
          one(paid[1]!.id),
        )
      ).status,
    ).toBe(200);
    // 98999c stays paid → round(8999.9) = 9000c: the void records +1c.
    expect(
      await db.supplierPaymentGstAdjustment.findMany({
        where: { billId: bill.id },
        select: { paymentId: true, creditableGstCents: true },
      }),
    ).toEqual([{ paymentId: paid[1]!.id, creditableGstCents: 1n }]);
    expect(await liveCredit()).toBe(9_000n);
    const replacement = (await pay(payment(bill.id, "1"))).body;
    expect(replacement.allocations[0]!.creditableGstAttributedCents).toBe("0");
    expect(await liveCredit()).toBe(9_000n);
    await expect(
      db.supplierPaymentGstAdjustment.deleteMany({
        where: { billId: bill.id },
      }),
    ).rejects.toThrow();
  });

  it("voids: a paid bill can't be voided until its payments are; voided payments reopen the bill", async () => {
    const job = await newJob();
    const recorded = await record({
      contractorId,
      jobId: job.id,
      issuedOn: "2026-07-15",
      lines: [SUBCONTRACT_LINE],
      documentId: await document(),
      evidenceVerified: true,
    });
    const paid = await pay(payment(recorded.body.id, "40000"));
    const blocked = await r().voidBill(
      call("accountant", "POST", { reason: "Entered twice" }),
      one(recorded.body.id),
    );
    expect(blocked.status).toBe(409);
    const voided = await r().voidPayment(
      call("accountant", "POST", { reason: "Bounced" }),
      one(paid.body.id),
    );
    expect(voided.status).toBe(200);
    expect(await readBill(recorded.body.id)).toMatchObject({
      paidCents: "0",
      outstandingCents: "99000",
    });
    expect(
      (
        await r().voidPayment(
          call("accountant", "POST", { reason: "Again" }),
          one(paid.body.id),
        )
      ).status,
    ).toBe(409);
    expect(await jobTotals(job.id)).toMatchObject({
      incurredCostCents: "90000",
    });
    const gone = await r().voidBill(
      call("accountant", "POST", { reason: "Entered twice" }),
      one(recorded.body.id),
    );
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as Bill).status).toBe("void");
    expect(await jobTotals(job.id)).toMatchObject({ incurredCostCents: "0" });
    // A void bill can't be paid.
    expect((await pay(payment(recorded.body.id, "100"))).status).toBe(400);
  });

  it("refuses edits and deletes through the database", async () => {
    const bill = await openBill();
    const paid = await pay(payment(bill.id, "100"));
    await expect(
      db.supplierBill.update({
        where: { id: bill.id },
        data: { jobCostCents: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db.supplierBill.delete({ where: { id: bill.id } }),
    ).rejects.toThrow();
    await expect(
      db.supplierPayment.update({
        where: { id: paid.body.id },
        data: { amountCents: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db.supplierPaymentAllocation.updateMany({
        where: { paymentId: paid.body.id },
        data: { amountCents: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      db.supplierBillItem.deleteMany({ where: { billId: bill.id } }),
    ).rejects.toThrow();
    expect((await readBill(bill.id)).paidCents).toBe("100");
  });
});

describe("one purchase document backs one record", () => {
  const expense = (receiptDocumentId: string, jobId: string | null = null) =>
    r().submitExpense(
      call("owner", "POST", {
        jobId,
        category: "materials",
        description: "Synthetic cable",
        purchasedOn: "2026-07-15",
        priceEntry: "inclusive",
        amountCents: "99000",
        taxCode: "TAXABLE_10",
        receiptDocumentId,
        settlement: "paid_at_purchase",
        paymentMethod: "card",
      }),
      undefined,
    );
  const bill = (documentId: string, extra: Record<string, unknown> = {}) =>
    record({
      supplierName: "Sample Supplies",
      supplierAbn: SUPPLIER_ABN,
      supplierGstRegistered: true,
      issuedOn: "2026-07-15",
      lines: [SUBCONTRACT_LINE],
      documentId,
      ...extra,
    });
  /** Wait until `count` sessions in this test database wait on a lock. */
  async function waitForLockWaiters(count: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Never saw ${count} lock waiters`);
  }

  it("refuses an expense on a bill's document, and a bill on an expense's", async () => {
    const billed = await document();
    expect((await bill(billed)).status).toBe(201);
    const refused = await expense(billed);
    expect(refused.status).toBe(400);
    expect((await refused.json()).fields).toHaveProperty("receiptDocumentId");

    const expensed = await document();
    expect((await expense(expensed)).status).toBe(201);
    const second = await bill(expensed);
    expect(second.status).toBe(400);
    expect(second.body.fields).toHaveProperty("documentId");
  });

  it("lets only one of a racing bill and expense claim a document", async () => {
    for (let run = 0; run < 3; run += 1) {
      const shared = await document();
      const [billed, expensed] = await Promise.all([
        bill(shared),
        expense(shared),
      ]);
      expect([billed.status, expensed.status].sort()).toEqual([201, 400]);
      const claims = await db.document.findUniqueOrThrow({
        where: { id: shared },
        select: {
          supplierBill: { select: { id: true } },
          expense: { select: { id: true } },
        },
      });
      expect(
        [claims.supplierBill, claims.expense].filter(Boolean),
      ).toHaveLength(1);
    }
  });

  // Codex #143 review (84fd7fb, P2): a job-linked bill took the document
  // first, then key-shared the job on insert, while an expense held the job
  // and waited for the document: a deadlock (40P01 → 500). Holding the job
  // lock queues the expense on the job first, then the bill, so the old order
  // deadlocks every time; the fixed order (contractor → job → document)
  // serialises them.
  it.each([
    ["a named supplier", () => ({})],
    ["a contractor", () => ({ contractorId })],
  ])(
    "a job-linked bill from %s and an expense on the same job and document don't deadlock",
    async (_supplier, extra) => {
      const job = await newJob();
      const shared = await document();
      let racing: Promise<[Response, Awaited<ReturnType<typeof bill>>]>;
      // Hold the job, queue the expense on it, then the bill; commit.
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
          const expensed = expense(shared, job.id);
          await waitForLockWaiters(1);
          const billed = bill(shared, { jobId: job.id, ...extra() });
          await waitForLockWaiters(2);
          racing = Promise.all([expensed, billed]);
        },
        { timeout: 30_000 },
      );
      const [expensed, billed] = await racing!;
      expect([expensed.status, billed.status]).toEqual([201, 400]);
      expect(billed.body.fields).toHaveProperty("documentId");
      const claims = await db.document.findUniqueOrThrow({
        where: { id: shared },
        select: {
          supplierBill: { select: { id: true } },
          expense: { select: { jobId: true } },
        },
      });
      expect(claims.supplierBill).toBeNull();
      expect(claims.expense?.jobId).toBe(job.id);
    },
  );
});
