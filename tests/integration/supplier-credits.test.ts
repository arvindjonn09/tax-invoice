import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { jobProfit } from "../../packages/domain/src/index";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  billHandlers,
  jobBillCosts,
  supplierCreditHandlers,
  supplierPaymentHandlers,
} from "../../apps/web/src/server/bills/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #140: supplier credit notes (adjustment notes) against bills. Fixture
// (docs/GST.md): the $990 contractor bill ($900 + $90 GST, valid tax invoice)
// on a job invoiced at $2,500 ex GST. Every case checks the bill's balance,
// its claimable GST and the job's profit.
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
let outsiderBillId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x1400);

type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
let routes: ReturnType<typeof makeRoutes>;
function makeRoutes() {
  const bills = billHandlers(() => db);
  const payments = supplierPaymentHandlers(() => db);
  const credits = supplierCreditHandlers(() => db);
  return {
    bill: withPolicy("bill.write", bills.create),
    billRead: withPolicy<One>("bill.read", bills.read),
    voidBill: withPolicy<One>("bill.write", bills.void),
    pay: withPolicy("payment.write", payments.create),
    voidPayment: withPolicy<One>("payment.write", payments.void),
    credit: withPolicy<One>("bill.write", credits.create),
    creditRead: withPolicy<One>("bill.read", credits.read),
    voidCredit: withPolicy<One>("bill.write", credits.void),
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
  outsiderBillId = (
    await db.supplierBill.create({
      data: {
        companyId: otherCompanyId,
        supplierName: "Their Supplier",
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
        reference: `JOB-140-${jobNumber}`,
        title: `Synthetic credited work ${jobNumber}`,
        status: "in_progress",
      },
    })
  ).id;
}

/** The fixture's subcontractor bill on `jobId`, with a verified tax invoice. */
async function fixtureBill(jobId: string, reference = randomUUID()) {
  const document = await db.document.create({
    data: {
      companyId,
      kind: "tax_invoice",
      objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
      fileName: "synthetic-tax-invoice.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      sha256: "a".repeat(64),
      createdBy: userIds.accountant,
    },
  });
  const response = await routes.bill(
    call("accountant", {
      jobId,
      supplierName: "Sample Sparks",
      supplierAbn: syntheticAbn("140140140"),
      supplierGstRegistered: true,
      supplierReference: reference,
      issuedOn: "2026-07-15",
      lines: [
        {
          description: "Synthetic wiring",
          taxCode: "TAXABLE_10",
          exclusiveCents: "90000",
          gstCents: "9000",
        },
      ],
      documentId: document.id,
      evidenceVerified: true,
    }),
    undefined,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const credit = (
  billId: string,
  exclusive: string,
  gst: string,
  who: Who = "accountant",
  taxCode = "TAXABLE_10",
) =>
  routes.credit(
    call(who, {
      supplierReference: `CN-${randomUUID().slice(0, 8)}`,
      issuedOn: "2026-07-20",
      receivedOn: "2026-07-20",
      lines: [
        {
          description: "Synthetic price adjustment",
          taxCode,
          exclusiveCents: exclusive,
          gstCents: gst,
        },
      ],
    }),
    one(billId),
  );

const pay = (billId: string, amountCents: string) =>
  routes.pay(
    call(
      "accountant",
      {
        paidOn: "2026-07-18",
        amountCents,
        method: "bank_transfer",
        allocations: [{ billId, amountCents }],
      },
      { "idempotency-key": `key-${randomUUID()}` },
    ),
    undefined,
  );

type BillView = {
  paidCents: string;
  creditedCents: string;
  outstandingCents: string;
  netJobCostCents: string;
  netCreditableGstCents: string;
  credits: { id: string; voidedAt: string | null }[];
};
const bill = async (id: string) =>
  (await (
    await routes.billRead(call("accountant"), one(id))
  ).json()) as BillView;

/** Live claimable GST on the cash basis: payments plus every correction. */
async function cashClaim(billId: string) {
  const [allocations, paymentFixes, creditFixes] = await Promise.all([
    db.supplierPaymentAllocation.aggregate({
      where: { billId, payment: { voidedAt: null } },
      _sum: { creditableGstAttributedCents: true },
    }),
    db.supplierPaymentGstAdjustment.aggregate({
      where: { billId },
      _sum: { creditableGstCents: true },
    }),
    db.supplierCreditGstAdjustment.aggregate({
      where: { billId },
      _sum: { creditableGstCents: true },
    }),
  ]);
  return (
    (allocations._sum.creditableGstAttributedCents ?? 0n) +
    (paymentFixes._sum.creditableGstCents ?? 0n) +
    (creditFixes._sum.creditableGstCents ?? 0n)
  ).toString();
}

/** R10 job profit: the fixture invoice's $2,500 ex GST less incurred bills. */
async function profitOf(jobId: string) {
  const { incurred } = await jobBillCosts(db, companyId, jobId);
  const result = jobProfit({
    revenueExclusive: [250_000n],
    jobCosts: [incurred],
  });
  return {
    cost: result.cost.toString(),
    profit: result.profit.toString(),
    margin: result.marginBasisPoints?.toString() ?? null,
  };
}

async function documentId(kind: "tax_invoice" | "other" = "tax_invoice") {
  return (
    await db.document.create({
      data: {
        companyId,
        kind,
        objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
        fileName: "synthetic.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        sha256: "c".repeat(64),
        createdBy: userIds.accountant,
      },
    })
  ).id;
}

/** A bill from any lines, with a verified tax invoice. */
async function billOf(
  jobId: string,
  lines: { taxCode: string; exclusiveCents: string; gstCents: string }[],
  extra: Record<string, unknown> = {},
) {
  const response = await routes.bill(
    call("accountant", {
      jobId,
      supplierName: `Sample Supplies ${randomUUID().slice(0, 6)}`,
      supplierAbn: syntheticAbn("142142142"),
      supplierGstRegistered: true,
      issuedOn: "2026-07-15",
      lines: lines.map((line) => ({ description: "Synthetic", ...line })),
      documentId: await documentId(),
      evidenceVerified: true,
      ...extra,
    }),
    undefined,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("supplier credits (#140)", () => {
  it("fixture: a $110 credit on the $990 bill lowers owing, claim and cost", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    expect(await profitOf(job)).toEqual({
      cost: "90000",
      profit: "160000",
      margin: "6400",
    });
    const response = await credit(billId, "10000", "1000");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      billId,
      inclusiveCents: "11000",
      creditableGstCents: "1000",
      nonCreditableGstCents: "0",
      jobCostCents: "10000",
      cashGstAdjustments: [],
    });
    expect(await bill(billId)).toMatchObject({
      creditedCents: "11000",
      outstandingCents: "88000",
      netJobCostCents: "80000",
      netCreditableGstCents: "8000",
    });
    // Recoverable GST never reaches profit: cost falls by the $100 ex GST only.
    expect(await profitOf(job)).toEqual({
      cost: "80000",
      profit: "170000",
      margin: "6800",
    });
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "supplier_credit.recorded" },
      }),
    ).toBe(1);
  });

  it("paying the net bill attributes exactly the net claim (cash basis)", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    expect((await pay(billId, "40000")).status).toBe(201);
    // round(400 × 90 / 990) = 3636 attributed by the first payment.
    expect(await cashClaim(billId)).toBe("3636");
    expect((await credit(billId, "10000", "1000")).status).toBe(201);
    // 400 × 80 / 880 = 3636.36 → no correction needed.
    expect(await cashClaim(billId)).toBe("3636");
    expect(await bill(billId)).toMatchObject({
      paidCents: "40000",
      outstandingCents: "48000",
    });
    expect((await pay(billId, "48000")).status).toBe(201);
    // Fully paid: the claim is the bill's $90 less the credit's $10.
    expect(await cashClaim(billId)).toBe("8000");
    expect(await bill(billId)).toMatchObject({ outstandingCents: "0" });
    expect((await profitOf(job)).cost).toBe("80000");
  });

  it("all-taxable bills keep the same claim ratio, so credits after part payment need no correction", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    expect((await pay(billId, "60500")).status).toBe(201);
    expect(await cashClaim(billId)).toBe("5500"); // 605 × 90 / 990
    // Credit the whole remaining $385 ($350 + $35): the bill is now $605,
    // all paid, with $55 claimable — what's attributed already. Then a
    // smaller credit on another bill needs a real correction.
    expect((await credit(billId, "35000", "3500")).status).toBe(201);
    expect(await cashClaim(billId)).toBe("5500");
    expect(await bill(billId)).toMatchObject({ outstandingCents: "0" });

    const other = await fixtureBill(job);
    expect((await pay(other, "50000")).status).toBe(201);
    expect(await cashClaim(other)).toBe("4545"); // round(500 × 90 / 990)
    const corrected = await credit(other, "40000", "4000");
    expect(corrected.status).toBe(201);
    // Net bill $550 with $50 claimable, $500 paid: round(500 × 50 / 550) = 4545.
    expect(await cashClaim(other)).toBe("4545");
    expect((await profitOf(job)).cost).toBe(
      String(90_000 * 2 - 35_000 - 40_000),
    );
  });

  it("a credit that changes the claim ratio writes a dated cash correction, and its void reverses it", async () => {
    const job = await newJob();
    // $900 + $90 taxable and a $100 GST-free line: $1,090 with $90 claimable.
    const response = await routes.bill(
      call("accountant", {
        jobId: job,
        supplierName: "Mixed Sample Supplies",
        supplierAbn: syntheticAbn("141141141"),
        supplierGstRegistered: true,
        issuedOn: "2026-07-15",
        lines: [
          {
            description: "Taxable",
            taxCode: "TAXABLE_10",
            exclusiveCents: "90000",
            gstCents: "9000",
          },
          {
            description: "Freight",
            taxCode: "GST_FREE",
            exclusiveCents: "10000",
            gstCents: "0",
          },
        ],
        documentId: (
          await db.document.create({
            data: {
              companyId,
              kind: "tax_invoice",
              objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
              fileName: "synthetic.pdf",
              contentType: "application/pdf",
              sizeBytes: 1234,
              sha256: "b".repeat(64),
              createdBy: userIds.accountant,
            },
          })
        ).id,
        evidenceVerified: true,
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    const billId = ((await response.json()) as { id: string }).id;
    expect((await pay(billId, "54500")).status).toBe(201);
    expect(await cashClaim(billId)).toBe("4500"); // 545 × 90 / 1090
    // Credit the GST-free freight: net $990, still $90 claimable.
    const created = await credit(
      billId,
      "10000",
      "0",
      "accountant",
      "GST_FREE",
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      cashGstAdjustments: {
        event: string;
        creditableGstCents: string;
        adjustedOn: string;
      }[];
    };
    // round(545 × 90 / 990) = 4955 (49.545…) → +455 on the credit's date.
    expect(body.cashGstAdjustments).toEqual([
      {
        event: "recorded",
        creditableGstCents: "455",
        adjustedOn: "2026-07-20",
      },
    ]);
    expect(await cashClaim(billId)).toBe("4955");
    expect((await profitOf(job)).cost).toBe("90000");
    const voided = await routes.voidCredit(
      call("accountant", { reason: "Synthetic" }),
      one(body.id),
    );
    expect(voided.status).toBe(200);
    expect(
      ((await voided.json()) as typeof body).cashGstAdjustments.map((row) => [
        row.event,
        row.creditableGstCents,
      ]),
    ).toEqual([
      ["recorded", "455"],
      ["voided", "-455"],
    ]);
    expect(await cashClaim(billId)).toBe("4500");
    expect((await profitOf(job)).cost).toBe("100000");
    expect(await bill(billId)).toMatchObject({ outstandingCents: "54500" });
  });

  it("never credits beyond what is still owing, even when credits race", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    expect((await pay(billId, "90000")).status).toBe(201);
    // $90 owing: $90.01 is refused; money already paid isn't a credit.
    const over = await credit(billId, "8183", "818");
    expect(over.status).toBe(400);
    expect((await over.json()).error).toMatch(/still owing/);
    const before = await profitOf(job);
    const raced = await Promise.all([
      credit(billId, "6000", "600"),
      credit(billId, "6000", "600"),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 400]);
    expect(await bill(billId)).toMatchObject({
      creditedCents: "6600",
      outstandingCents: "2400",
    });
    expect((await profitOf(job)).cost).toBe(
      String(BigInt(before.cost) - 6_000n),
    );
  });

  it("refuses bad credits without recording anything", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    for (const [exclusive, gst, taxCode] of [
      ["0", "0", "TAXABLE_10"],
      ["10000", "2000", "TAXABLE_10"], // not 10%
      ["10000", "100", "GST_FREE"], // GST on a GST-free line
      ["90001", "0", "GST_FREE"], // more than the bill's ex GST
    ] as const)
      expect(
        (await credit(billId, exclusive, gst, "accountant", taxCode)).status,
      ).toBe(400);
    for (const amount of ["-1", "1.5", "1e5", "99999999999999"])
      expect(
        (await credit(billId, amount, "0", "accountant", "GST_FREE")).status,
      ).toBe(400);
    // Dated before the bill, or in the future.
    for (const issuedOn of ["2026-07-14", "2999-01-01"])
      expect(
        (
          await routes.credit(
            call("accountant", {
              issuedOn,
              lines: [
                {
                  description: "Synthetic",
                  taxCode: "TAXABLE_10",
                  exclusiveCents: "1000",
                  gstCents: "100",
                },
              ],
            }),
            one(billId),
          )
        ).status,
      ).toBe(400);
    expect(await db.supplierCredit.count({ where: { billId } })).toBe(0);
    expect(await bill(billId)).toMatchObject({
      creditedCents: "0",
      outstandingCents: "99000",
    });
    expect((await profitOf(job)).cost).toBe("90000");
  });

  it("voiding a credit restores owing, claim and cost; the bill can then be voided", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    const created = (await (await credit(billId, "10000", "1000")).json()) as {
      id: string;
    };
    // A bill with a live credit can't be voided.
    expect(
      (
        await routes.voidBill(
          call("accountant", { reason: "Synthetic" }),
          one(billId),
        )
      ).status,
    ).toBe(409);
    const voided = await routes.voidCredit(
      call("accountant", { reason: "Synthetic: wrong bill" }),
      one(created.id),
    );
    expect(voided.status).toBe(200);
    expect(await voided.json()).toMatchObject({
      voidReason: "Synthetic: wrong bill",
    });
    expect(
      (
        await routes.voidCredit(
          call("accountant", { reason: "again" }),
          one(created.id),
        )
      ).status,
    ).toBe(409);
    expect(await bill(billId)).toMatchObject({
      creditedCents: "0",
      outstandingCents: "99000",
      netJobCostCents: "90000",
      netCreditableGstCents: "9000",
    });
    expect((await profitOf(job)).cost).toBe("90000");
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "supplier_credit.voided" },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (
        await routes.voidBill(
          call("accountant", { reason: "Synthetic" }),
          one(billId),
        )
      ).status,
    ).toBe(200);
    expect((await profitOf(job)).cost).toBe("0");
  });

  it("re-bases the cash claim when a credit on a part-paid bill is voided", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    const created = (await (await credit(billId, "40000", "4000")).json()) as {
      id: string;
    };
    expect((await pay(billId, "55000")).status).toBe(201); // the whole net bill
    expect(await cashClaim(billId)).toBe("5000");
    expect(
      (
        await routes.voidCredit(
          call("accountant", { reason: "Synthetic" }),
          one(created.id),
        )
      ).status,
    ).toBe(200);
    // Back to $990 with $550 paid: round(550 × 90 / 990) = 5000. Owing $440.
    expect(await cashClaim(billId)).toBe("5000");
    expect(await bill(billId)).toMatchObject({ outstandingCents: "44000" });
    expect((await pay(billId, "44000")).status).toBe(201);
    expect(await cashClaim(billId)).toBe("9000");
  });

  it("dates a cash correction no earlier than the payments it re-splits or the note's arrival", async () => {
    const job = await newJob();
    const billId = await billOf(job, [
      { taxCode: "TAXABLE_10", exclusiveCents: "90000", gstCents: "9000" },
      { taxCode: "GST_FREE", exclusiveCents: "10000", gstCents: "0" },
    ]);
    const late = await routes.pay(
      call(
        "accountant",
        {
          paidOn: "2026-07-25",
          amountCents: "54500",
          method: "bank_transfer",
          allocations: [{ billId, amountCents: "54500" }],
        },
        { "idempotency-key": `key-${randomUUID()}` },
      ),
      undefined,
    );
    expect(late.status).toBe(201);
    const issued = await routes.credit(
      call("accountant", {
        issuedOn: "2026-07-20",
        receivedOn: "2026-07-22",
        lines: [
          {
            description: "Freight",
            taxCode: "GST_FREE",
            exclusiveCents: "10000",
            gstCents: "0",
          },
        ],
      }),
      one(billId),
    );
    expect(issued.status).toBe(201);
    // Payment on 25 Jul is after the credit (20 Jul) and its arrival (22 Jul).
    expect(
      (
        (await issued.json()) as {
          cashGstAdjustments: { adjustedOn: string }[];
        }
      ).cashGstAdjustments.map((row) => row.adjustedOn),
    ).toEqual(["2026-07-25"]);
    // Received before it was issued, or in the future: refused.
    for (const receivedOn of ["2026-07-19", "2999-01-01"])
      expect(
        (
          await routes.credit(
            call("accountant", {
              issuedOn: "2026-07-20",
              receivedOn,
              lines: [
                {
                  description: "x",
                  taxCode: "GST_FREE",
                  exclusiveCents: "100",
                  gstCents: "0",
                },
              ],
            }),
            one(billId),
          )
        ).status,
      ).toBe(400);
  });

  it("a credit that raises the cash claim by more than $75 needs a verified note", async () => {
    const job = await newJob();
    // $1,000 + $100 taxable and $10,000 GST-free: $11,100 with $100 claimable.
    const billId = await billOf(job, [
      { taxCode: "TAXABLE_10", exclusiveCents: "100000", gstCents: "10000" },
      { taxCode: "GST_FREE", exclusiveCents: "1000000", gstCents: "0" },
    ]);
    expect((await pay(billId, "200000")).status).toBe(201);
    expect(await cashClaim(billId)).toBe("1802"); // round(2000 × 100 / 11100)
    // Crediting $9,000 of GST-free goods carries no GST of its own, yet the
    // claim rises: net $2,100 with $100 claimable, round(2000 × 100 / 2100).
    const lines = [
      {
        description: "Returned stock",
        taxCode: "GST_FREE",
        exclusiveCents: "900000",
        gstCents: "0",
      },
    ];
    const body = (extra: Record<string, unknown>) =>
      call("accountant", {
        issuedOn: "2026-07-20",
        receivedOn: "2026-07-20",
        lines,
        ...extra,
      });
    const refused = await routes.credit(body({}), one(billId));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/adjustment note/);
    expect(await db.supplierCredit.count({ where: { billId } })).toBe(0);
    expect(await cashClaim(billId)).toBe("1802");
    const held = await routes.credit(
      body({ documentId: await documentId("other"), evidenceVerified: true }),
      one(billId),
    );
    expect(held.status).toBe(201);
    expect(await cashClaim(billId)).toBe("9524"); // +7722, over $75
    expect(await bill(billId)).toMatchObject({
      creditedCents: "900000",
      outstandingCents: "10000",
      netCreditableGstCents: "10000",
    });
    // Cost: $11,000 ex GST less $9,000 credited = $2,000.
    expect((await profitOf(job)).cost).toBe("200000");
  });

  it("a raise of $75 or less needs no note", async () => {
    const job = await newJob();
    const billId = await billOf(job, [
      { taxCode: "TAXABLE_10", exclusiveCents: "100000", gstCents: "10000" },
      { taxCode: "GST_FREE", exclusiveCents: "200000", gstCents: "0" },
    ]);
    expect((await pay(billId, "20000")).status).toBe(201);
    expect(await cashClaim(billId)).toBe("645"); // round(200 × 100 / 3100)
    const created = await credit(
      billId,
      "190000",
      "0",
      "accountant",
      "GST_FREE",
    );
    expect(created.status).toBe(201);
    // Net $1,200 with $100 claimable: round(200 × 100 / 1200) = 1667, +$10.22.
    expect(await cashClaim(billId)).toBe("1667");
    expect((await profitOf(job)).cost).toBe("110000");
  });

  it("refuses the same supplier note twice on a bill, even concurrently", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    const same = () =>
      routes.credit(
        call("accountant", {
          supplierReference: "CN-SAME-1",
          issuedOn: "2026-07-20",
          lines: [
            {
              description: "x",
              taxCode: "TAXABLE_10",
              exclusiveCents: "1000",
              gstCents: "100",
            },
          ],
        }),
        one(billId),
      );
    const statuses = (await Promise.all([same(), same()]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    expect(await bill(billId)).toMatchObject({ creditedCents: "1100" });
    expect((await profitOf(job)).cost).toBe("89000");
  });

  it("a credit racing a payment never takes the bill below zero", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    const [credited, paid] = await Promise.all([
      credit(billId, "60000", "6000"),
      pay(billId, "50000"),
    ]);
    // $660 credit + $500 payment > $990: exactly one fits.
    expect([credited.status, paid.status].sort()).toEqual([201, 400]);
    const view = await bill(billId);
    expect(BigInt(view.outstandingCents)).toBeGreaterThanOrEqual(0n);
    expect(
      BigInt(view.creditedCents) +
        BigInt(view.paidCents) +
        BigInt(view.outstandingCents),
    ).toBe(99_000n);
    expect((await profitOf(job)).cost).toBe(
      credited.status === 201 ? "30000" : "90000",
    );
  });

  it("credits a partly claimable bill at its share; commitment stays with the gross bill", async () => {
    const job = await newJob();
    const contractor = await db.contractor.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        name: `Sample Sparks ${randomUUID().slice(0, 6)}`,
        abn: syntheticAbn("143143143"),
        gstRegistered: true,
      },
    });
    const offer = await db.contractorOffer.create({
      data: {
        companyId,
        jobId: job,
        contractorId: contractor.id,
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
        jobId: job,
        contractorId: contractor.id,
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
    const recorded = await routes.bill(
      call("accountant", {
        contractorId: contractor.id,
        offerId: offer.id,
        issuedOn: "2026-07-15",
        lines: [
          {
            description: "Wiring",
            taxCode: "TAXABLE_10",
            exclusiveCents: "90000",
            gstCents: "9000",
          },
        ],
        documentId: await documentId(),
        evidenceVerified: true,
        creditableBasisPoints: 5000,
        creditableReason: "Synthetic: half private use",
      }),
      undefined,
    );
    expect(recorded.status).toBe(201);
    const billId = ((await recorded.json()) as { id: string }).id;
    expect(await jobBillCosts(db, companyId, job)).toEqual({
      incurred: 94_500n,
      committed: 0n,
    });
    const response = await credit(billId, "10000", "1000");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      creditableGstCents: "500",
      nonCreditableGstCents: "500",
      jobCostCents: "10500",
    });
    // Incurred falls by $105; the offer stays fully billed (no new commitment).
    expect(await jobBillCosts(db, companyId, job)).toEqual({
      incurred: 84_000n,
      committed: 0n,
    });
    expect(await bill(billId)).toMatchObject({ netCreditableGstCents: "4000" });
  });

  it("an unregistered company's credit claims nothing back; all of its GST is cost", async () => {
    const job = await newJob();
    // Before the 1 Jul 2025 registration: no credit was ever claimable.
    const response = await routes.bill(
      call("accountant", {
        jobId: job,
        supplierName: "Early Sample Supplies",
        supplierAbn: syntheticAbn("144144144"),
        supplierGstRegistered: true,
        issuedOn: "2025-06-30",
        lines: [
          {
            description: "Early",
            taxCode: "TAXABLE_10",
            exclusiveCents: "90000",
            gstCents: "9000",
          },
        ],
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    const billId = ((await response.json()) as { id: string }).id;
    expect((await profitOf(job)).cost).toBe("99000");
    const created = await credit(billId, "10000", "1000");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      creditableGstCents: "0",
      nonCreditableGstCents: "1000",
      jobCostCents: "11000",
    });
    expect((await profitOf(job)).cost).toBe("88000");
    expect(await bill(billId)).toMatchObject({ netCreditableGstCents: "0" });
  });

  it("is immutable in the database: no edits, deletes or line changes", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    const created = (await (await credit(billId, "10000", "1000")).json()) as {
      id: string;
    };
    await expect(
      db.supplierCredit.update({
        where: { id: created.id },
        data: { inclusiveCents: 1n, exclusiveCents: 1n, gstCents: 0n },
      }),
    ).rejects.toThrow();
    await expect(
      db.supplierCredit.delete({ where: { id: created.id } }),
    ).rejects.toThrow();
    await expect(
      db.supplierCreditItem.updateMany({
        where: { creditId: created.id },
        data: { description: "Edited" },
      }),
    ).rejects.toThrow();
    await expect(
      db.supplierCreditItem.deleteMany({ where: { creditId: created.id } }),
    ).rejects.toThrow();
    expect(await bill(billId)).toMatchObject({ creditedCents: "11000" });
  });

  it("lets owner and accountant record, office roles read; isolates tenants", async () => {
    const job = await newJob();
    const billId = await fixtureBill(job);
    expect((await credit(billId, "1000", "100", "owner")).status).toBe(201);
    for (const who of ["manager", "employee"] as const)
      expect((await credit(billId, "1000", "100", who)).status).toBe(403);
    const created = (
      await db.supplierCredit.findFirstOrThrow({ where: { billId } })
    ).id;
    expect(
      (await routes.creditRead(call("manager"), one(created))).status,
    ).toBe(200);
    expect(
      (await routes.creditRead(call("employee"), one(created))).status,
    ).toBe(403);
    // Another company's bill and credit don't exist here.
    expect(
      (await credit(outsiderBillId, "1000", "0", "accountant", "GST_FREE"))
        .status,
    ).toBe(404);
    expect(
      (await routes.creditRead(call("outsider"), one(created))).status,
    ).toBe(404);
    expect(
      (await routes.voidCredit(call("outsider", { reason: "x" }), one(created)))
        .status,
    ).toBe(404);
  });
});
