import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import { receiptHandlers } from "../../apps/web/src/server/receipts/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #50: customer receipts and refunds — idempotent, transactional, no
// overpayment, cash-basis GST attribution, profit untouched.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "manager", "accountant", "employee", "outsider"] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let invoices: ReturnType<typeof invoiceHandlers>;
let receipts: ReturnType<typeof receiptHandlers>;
let companyId = "";
let customerId = "";
let otherCustomerId = "";
let outsiderReceiptId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x5050);

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
  invoices = invoiceHandlers(() => db);
  receipts = receiptHandlers(() => db);
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
  await db.company.update({
    where: { id: companyId },
    data: { legalName: "Sample Pty Ltd", abn: syntheticAbn("505050505") },
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
  otherCustomerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Bravo Sample" },
    })
  ).id;
  const theirCustomer = await db.customer.create({
    data: { companyId: other.id, createdBy: userIds.outsider, name: "Theirs" },
  });
  outsiderReceiptId = (
    await db.customerReceipt.create({
      data: {
        companyId: other.id,
        customerId: theirCustomer.id,
        receivedOn: new Date("2026-07-01T00:00:00Z"),
        amountCents: 100n,
        method: "cash",
        idempotencyKey: "outsider-key-1",
        requestHash: "0".repeat(64),
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
  invCreate: withPolicy("invoice.write", invoices.create),
  invIssue: withPolicy("invoice.issue", invoices.issue),
  invRead: withPolicy("invoice.read", invoices.read),
  invVoid: withPolicy("invoice.issue", invoices.void),
  create: withPolicy("payment.write", receipts.create),
  read: withPolicy("payment.read", receipts.read),
  list: withPolicy("payment.read", receipts.list),
  void: withPolicy("payment.write", receipts.void),
});

/** An issued $2,750 (incl. $250 GST) invoice for `customer`. */
async function issuedInvoice(customer = customerId, priceCents = "250000") {
  const draft = await (
    await r().invCreate(
      call("accountant", "POST", {
        customerId: customer,
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
  const issued = await r().invIssue(
    call("accountant", "POST", { issueDate: "2026-07-01" }),
    one(draft.id),
  );
  expect(issued.status).toBe(200);
  return draft.id as string;
}

function receive(
  allocations: { invoiceId: string; amountCents: string }[],
  {
    amount = allocations
      .reduce((t, a) => t + BigInt(a.amountCents), 0n)
      .toString(),
    key = `key-${randomUUID()}`,
    who = "accountant" as Who,
    kind = "receipt",
    customer = customerId,
  } = {},
) {
  return r().create(
    call(
      who,
      "POST",
      {
        customerId: customer,
        kind,
        receivedOn: "2026-07-05",
        amountCents: amount,
        method: "bank_transfer",
        allocations,
      },
      { "idempotency-key": key },
    ),
    undefined,
  );
}
const balanceOf = async (invoiceId: string) =>
  (await (
    await r().invRead(call("accountant", "GET"), one(invoiceId))
  ).json()) as {
    receivedCents: string;
    outstandingCents: string;
    exclusiveCents: string;
    gstCents: string;
  };

describe("receipts", () => {
  it("fixture: $1,000 on a $2,750 invoice → $1,750 outstanding; revenue/profit inputs unchanged", async () => {
    const invoiceId = await issuedInvoice();
    const before = await balanceOf(invoiceId);
    const response = await receive([{ invoiceId, amountCents: "100000" }]);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      amountCents: "100000",
      allocations: [
        // Cash-basis GST: round(100000 × 25000 / 275000) = 9091.
        { invoiceId, amountCents: "100000", gstAttributedCents: "9091" },
      ],
    });
    const after = await balanceOf(invoiceId);
    expect(after).toMatchObject({
      receivedCents: "100000",
      outstandingCents: "175000",
    });
    // Receipts never change the invoice's revenue or GST (profit inputs).
    expect([after.exclusiveCents, after.gstCents]).toEqual([
      before.exclusiveCents,
      before.gstCents,
    ]);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "receipt.recorded" },
      }),
    ).toBe(1);
  });

  it("creates exactly one receipt for concurrent duplicate submissions", async () => {
    const invoiceId = await issuedInvoice();
    const key = `dup-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        receive([{ invoiceId, amountCents: "275000" }], { key }),
      ),
    );
    const bodies = await Promise.all(results.map((res) => res.json()));
    expect(results.map((res) => res.status).sort()).toEqual([
      200, 200, 200, 200, 201,
    ]);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(
      await db.customerReceipt.count({ where: { idempotencyKey: key } }),
    ).toBe(1);
    expect((await balanceOf(invoiceId)).outstandingCents).toBe("0");
    // The same key for a different request is refused.
    expect(
      (await receive([{ invoiceId, amountCents: "1" }], { key })).status,
    ).toBe(409);
  });

  it("rejects overpayment, bad splits and other customers' or unissued invoices", async () => {
    const invoiceId = await issuedInvoice();
    const theirs = await issuedInvoice(otherCustomerId);
    expect((await receive([{ invoiceId, amountCents: "275001" }])).status).toBe(
      400,
    );
    expect(
      (await receive([{ invoiceId, amountCents: "1000" }], { amount: "2000" }))
        .status,
    ).toBe(400);
    expect(
      (await receive([{ invoiceId: theirs, amountCents: "1000" }])).status,
    ).toBe(400);
    const draft = await (
      await r().invCreate(
        call("accountant", "POST", { customerId, lines: [] }),
        undefined,
      )
    ).json();
    expect(
      (await receive([{ invoiceId: draft.id, amountCents: "1" }])).status,
    ).toBe(400);
    expect(
      (await receive([{ invoiceId, amountCents: "1" }], { key: "short" }))
        .status,
    ).toBe(400);
  });

  it("never overpays when two different receipts race for the same invoice", async () => {
    const invoiceId = await issuedInvoice();
    const results = await Promise.all([
      receive([{ invoiceId, amountCents: "200000" }]),
      receive([{ invoiceId, amountCents: "200000" }]),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 400]);
    expect((await balanceOf(invoiceId)).receivedCents).toBe("200000");
  });

  it("allocates one payment across several invoices", async () => {
    const a = await issuedInvoice();
    const b = await issuedInvoice(customerId, "100000");
    const response = await receive([
      { invoiceId: a, amountCents: "275000" },
      { invoiceId: b, amountCents: "50000" },
    ]);
    expect(response.status).toBe(201);
    expect((await balanceOf(a)).outstandingCents).toBe("0");
    expect((await balanceOf(b)).outstandingCents).toBe("60000");
  });
});

describe("refunds and voids", () => {
  it("refunds at most what was received; voids follow the money", async () => {
    const invoiceId = await issuedInvoice();
    const paid = await (
      await receive([{ invoiceId, amountCents: "100000" }])
    ).json();
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
    const refundBody = await refund.json();
    expect(refundBody.allocations[0].gstAttributedCents).toMatch(/^-/);
    expect((await balanceOf(invoiceId)).receivedCents).toBe("60000");
    // The invoice has money against it: it can't be voided.
    expect(
      (
        await r().invVoid(
          call("accountant", "POST", { reason: "x" }),
          one(invoiceId),
        )
      ).status,
    ).toBe(409);
    // Voiding the receipt first would leave the refund returning money never received.
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Bounced" }),
          one(paid.id),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Not refunded" }),
          one(refundBody.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Bounced" }),
          one(paid.id),
        )
      ).status,
    ).toBe(200);
    expect((await balanceOf(invoiceId)).outstandingCents).toBe("275000");
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Again" }),
          one(paid.id),
        )
      ).status,
    ).toBe(409);
    // With all receipts void, the invoice can be voided.
    expect(
      (
        await r().invVoid(
          call("accountant", "POST", { reason: "Wrong customer" }),
          one(invoiceId),
        )
      ).status,
    ).toBe(200);
  });

  it("refuses a refund void that would overpay after a replacement receipt", async () => {
    const invoiceId = await issuedInvoice();
    const due = (await balanceOf(invoiceId)).outstandingCents;
    await receive([{ invoiceId, amountCents: due }]);
    const refund = await (
      await receive([{ invoiceId, amountCents: due }], { kind: "refund" })
    ).json();
    const replacement = await receive([{ invoiceId, amountCents: due }]);
    expect(replacement.status).toBe(201);
    const voided = await r().void(
      call("accountant", "POST", { reason: "Refund never sent" }),
      one(refund.id),
    );
    expect(voided.status).toBe(409);
    expect((await voided.json()).error).toMatch(/overpay/);
    expect((await balanceOf(invoiceId)).receivedCents).toBe(due);
  });

  it("never overpays when a refund void races a replacement receipt", async () => {
    const invoiceId = await issuedInvoice();
    const due = (await balanceOf(invoiceId)).outstandingCents;
    await receive([{ invoiceId, amountCents: due }]);
    const refund = await (
      await receive([{ invoiceId, amountCents: due }], { kind: "refund" })
    ).json();
    const [voided, replacement] = await Promise.all([
      r().void(
        call("accountant", "POST", { reason: "Refund never sent" }),
        one(refund.id),
      ),
      receive([{ invoiceId, amountCents: due }]),
    ]);
    // Exactly one of them takes the invoice back to fully paid.
    // Either the void wins and the receipt would overpay (400), or the
    // receipt wins and the void would (409).
    expect([
      [200, 400],
      [409, 201],
    ]).toContainEqual([voided.status, replacement.status]);
    expect((await balanceOf(invoiceId)).receivedCents).toBe(due);
  });

  it("is immutable in the database: no edits, deletes or allocation changes", async () => {
    const invoiceId = await issuedInvoice();
    const paid = await (
      await receive([{ invoiceId, amountCents: "1000" }])
    ).json();
    await expect(
      db.customerReceipt.update({
        where: { id: paid.id },
        data: { amountCents: 2000n },
      }),
    ).rejects.toThrow(/can't be edited/);
    await expect(
      db.customerReceipt.delete({ where: { id: paid.id } }),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db.receiptAllocation.updateMany({
        where: { receiptId: paid.id },
        data: { amountCents: 1n },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe("access", () => {
  it("lets office roles read, only owner/accountant record; isolates tenants", async () => {
    const invoiceId = await issuedInvoice();
    expect(
      (await receive([{ invoiceId, amountCents: "10" }], { who: "manager" }))
        .status,
    ).toBe(403);
    expect(
      (await receive([{ invoiceId, amountCents: "10" }], { who: "employee" }))
        .status,
    ).toBe(403);
    expect((await r().list(call("manager", "GET"), undefined)).status).toBe(
      200,
    );
    expect((await r().list(call("employee", "GET"), undefined)).status).toBe(
      403,
    );
    for (const id of [
      outsiderReceiptId,
      "00000000-0000-4000-8000-000000000000",
      "x",
    ]) {
      expect((await r().read(call("owner", "GET"), one(id))).status, id).toBe(
        404,
      );
      expect(
        (await r().void(call("owner", "POST", { reason: "x" }), one(id)))
          .status,
        id,
      ).toBe(404);
    }
  });
});
