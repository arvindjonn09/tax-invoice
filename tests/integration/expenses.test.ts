import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expenseTotals } from "../../packages/domain/src/index";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { expenseHandlers } from "../../apps/web/src/server/expenses/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #40: job and general expenses with GST code, ex/incl entry, creditable
// share and receipts; settlement paid at purchase or on account; cost incurred
// once on approval; decided expenses are final and corrected by reversal.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
type Who = (typeof ROLES)[number] | "employee2" | "outsider";
const PEOPLE = [...ROLES, "employee2", "outsider"] as const;

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof expenseHandlers>;
let companyId = "";
let otherCompanyId = "";
let assignedJobId = "";
let otherJobId = "";
let outsiderJobId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x4040);

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
  handlers = expenseHandlers(() => db);
  for (const key of PEOPLE) {
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
  for (const [key, role] of [
    ...ROLES.slice(1).map((role) => [role, role] as const),
    ["employee2", "employee"] as const,
  ]) {
    await db.membership.create({
      data: { companyId, userId: userIds[key], createdBy: userIds.owner, role },
    });
  }
  // Registered for GST from 2020-01-01 (the outsider's company never is).
  await db.companyGstRegistration.create({
    data: {
      companyId,
      startsOn: new Date("2020-01-01T00:00:00Z"),
      basis: "non_cash",
      createdBy: userIds.owner,
    },
  });
  const customer = await db.customer.create({
    data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
  });
  const job = (
    number: number,
    company = companyId,
    customerId = customer.id,
    by = userIds.owner,
  ) =>
    db.job.create({
      data: {
        companyId: company,
        customerId,
        number,
        reference: `SJ-${number}`,
        title: `Sample job ${number}`,
        agreedPriceExclusiveCents: 250000n,
        createdBy: by,
      },
    });
  assignedJobId = (await job(1)).id;
  otherJobId = (await job(2)).id;
  const theirCustomer = await db.customer.create({
    data: {
      companyId: otherCompanyId,
      createdBy: userIds.outsider,
      name: "Other Co",
    },
  });
  outsiderJobId = (
    await job(1, otherCompanyId, theirCustomer.id, userIds.outsider)
  ).id;
  for (const key of ["employee", "employee2"] as const) {
    const employee = await db.employee.create({
      data: {
        companyId,
        name: `Synthetic ${key}`,
        userId: userIds[key],
        createdBy: userIds.owner,
      },
    });
    if (key === "employee")
      await db.assignment.create({
        data: {
          companyId,
          jobId: assignedJobId,
          employeeId: employee.id,
          createdBy: userIds.owner,
        },
      });
  }
  let ip = 0;
  for (const key of PEOPLE) {
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
}, 90_000);
afterAll(() => database?.release());

function call(who: Who, method: string, body?: unknown, query = ""): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/expenses${query}`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  list: withPolicy("expense.read_all", handlers.list),
  read: withPolicy<One>("expense.read_all", handlers.read),
  mine: withPolicy("expense.submit_own", handlers.mine),
  create: withPolicy("expense.submit_own", handlers.create),
  update: withPolicy<One>("expense.submit_own", handlers.update),
  decide: withPolicy<One>("expense.approve", handlers.decide),
  reverse: withPolicy<One>("expense.approve", handlers.reverse),
});

const MATERIALS = {
  category: "materials",
  description: "Cable and conduit",
  supplierName: "Sample Wholesale",
  purchasedOn: "2026-07-01",
  priceEntry: "exclusive",
  amountCents: "15000",
  taxCode: "TAXABLE_10",
  settlement: "paid_at_purchase",
  paymentMethod: "card",
};

async function receipt(
  who: Who,
  kind: "receipt" | "tax_invoice" | "photo" = "receipt",
) {
  const company = who === "outsider" ? otherCompanyId : companyId;
  return db.document.create({
    data: {
      companyId: company,
      kind,
      objectKey: `documents/${company}/${randomBytes(32).toString("hex")}`,
      fileName: "receipt.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      sha256: "0".repeat(64),
      createdBy: userIds[who],
    },
  });
}

async function submit(
  body: Record<string, unknown> = {},
  who: Who = "manager",
) {
  const response = await r().create(
    call(who, "POST", { jobId: assignedJobId, ...MATERIALS, ...body }),
    undefined,
  );
  return { response, body: await response.json() };
}

const decide = (
  id: string,
  decision: "approve" | "reject",
  who: Who = "manager",
  extra: Record<string, unknown> = {},
) => r().decide(call(who, "POST", { decision, ...extra }), one(id));

/** Submit and approve; the approver verifies the evidence when a document is attached. */
async function approved(
  body: Record<string, unknown> = {},
  evidenceVerified = Boolean(body.receiptDocumentId),
) {
  const { body: created } = await submit(body);
  const response = await decide(created.id, "approve", "manager", {
    evidenceVerified,
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("submitting", () => {
  it("records ex/incl GST entry, tax code, creditable share and settlement, audited", async () => {
    const document = await receipt("manager");
    const { response, body } = await submit({ receiptDocumentId: document.id });
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      jobId: assignedJobId,
      amountCents: "15000",
      exclusiveCents: "15000",
      gstCents: "1500",
      inclusiveCents: "16500",
      creditablePercent: "100",
      settlement: "paid_at_purchase",
      paidOn: "2026-07-01",
      paymentMethod: "card",
      status: "submitted",
      approval: null,
    });
    const inclusive = await submit({
      priceEntry: "inclusive",
      amountCents: 16500,
    });
    expect(inclusive.body).toMatchObject({
      exclusiveCents: "15000",
      gstCents: "1500",
    });
    expect(
      await db.auditEvent.count({
        where: { targetId: body.id, action: "expense.submitted" },
      }),
    ).toBe(1);
  });

  it("uses the company's default settlement; on account records no payment", async () => {
    await db.company.update({
      where: { id: companyId },
      data: { defaultExpenseSettlement: "on_account" },
    });
    const { body } = await submit({
      settlement: undefined,
      paymentMethod: undefined,
    });
    expect(body).toMatchObject({
      settlement: "on_account",
      paidOn: null,
      paymentMethod: null,
    });
    await db.company.update({
      where: { id: companyId },
      data: { defaultExpenseSettlement: "paid_at_purchase" },
    });
    const paid = await submit({
      settlement: undefined,
      paymentMethod: undefined,
    });
    expect(paid.response.status).toBe(400);
    expect(paid.body.fields).toHaveProperty("paymentMethod");
    const mixed = await submit({
      settlement: "on_account",
      paymentMethod: "cash",
    });
    expect(mixed.response.status).toBe(400);
  });

  it("validates every write", async () => {
    for (const bad of [
      { amountCents: "-1" },
      { amountCents: 1.5 },
      { taxCode: "GST" },
      { category: "food" },
      { description: " " },
      { purchasedOn: "2999-01-01" },
      { creditablePercent: "101" },
      { priceEntry: "gross" },
      { jobId: "not-a-uuid" },
    ]) {
      const { response } = await submit(bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("supports general (no job) expenses for the office only", async () => {
    const office = await submit({
      jobId: null,
      category: "parking",
      taxCode: "TAXABLE_10",
      amountCents: "2200",
      priceEntry: "inclusive",
    });
    expect(office.response.status).toBe(201);
    expect(office.body.jobId).toBeNull();
    const employee = await submit({ jobId: null }, "employee");
    expect(employee.response.status).toBe(400);
  });

  it("lets employees submit only for jobs they're assigned to", async () => {
    expect((await submit({}, "employee")).response.status).toBe(201);
    expect(
      (await submit({ jobId: otherJobId }, "employee")).response.status,
    ).toBe(400);
    expect((await submit({}, "employee2")).response.status).toBe(400);
    // Employees get their own view: no approval snapshot or submitter ids.
    const mine = await (
      await r().mine(call("employee", "GET"), undefined)
    ).json();
    expect(mine.total).toBeGreaterThan(0);
    for (const item of mine.expenses) {
      expect(item).not.toHaveProperty("approval");
      expect(item).not.toHaveProperty("submittedBy");
    }
  });

  it("attaches only the submitter's own receipt (or any, for the office), once", async () => {
    const theirs = await receipt("employee2");
    expect(
      (await submit({ receiptDocumentId: theirs.id }, "employee")).response
        .status,
    ).toBe(400);
    const photo = await receipt("employee", "photo");
    expect(
      (await submit({ receiptDocumentId: photo.id }, "employee")).response
        .status,
    ).toBe(400);
    const own = await receipt("employee", "tax_invoice");
    expect(
      (await submit({ receiptDocumentId: own.id }, "employee")).response.status,
    ).toBe(201);
    expect(
      (await submit({ receiptDocumentId: own.id }, "manager")).response.status,
    ).toBe(400);
    const foreign = await receipt("outsider");
    expect(
      (await submit({ receiptDocumentId: foreign.id })).response.status,
    ).toBe(400);
  });

  it("refuses accountants and subcontractors submitting, and workers reading all", async () => {
    for (const who of ["accountant", "subcontractor"] as const)
      expect((await submit({}, who)).response.status, who).toBe(403);
    for (const who of ["employee", "subcontractor"] as const)
      expect((await r().list(call(who, "GET"), undefined)).status, who).toBe(
        403,
      );
    const { body } = await submit({}, "employee");
    expect((await decide(body.id, "approve", "employee")).status).toBe(403);
    expect((await decide(body.id, "approve", "accountant")).status).toBe(403);
  });

  it("isolates tenants", async () => {
    const { body } = await submit();
    for (const who of ["outsider"] as const) {
      expect((await r().read(call(who, "GET"), one(body.id))).status).toBe(404);
      expect((await decide(body.id, "approve", who)).status).toBe(404);
      expect(
        (
          await r().update(
            call(who, "PATCH", { description: "x" }),
            one(body.id),
          )
        ).status,
      ).toBe(404);
    }
    expect((await submit({ jobId: outsiderJobId })).response.status).toBe(400);
    const forged = await submit({ companyId: otherCompanyId });
    expect(
      (await db.expense.findUniqueOrThrow({ where: { id: forged.body.id } }))
        .companyId,
    ).toBe(companyId);
  });
});

describe("approval: cost incurred once", () => {
  it("issue fixture: $150 + $15 creditable → cost $150", async () => {
    const document = await receipt("manager", "tax_invoice");
    const body = await approved({ receiptDocumentId: document.id });
    expect(body).toMatchObject({
      status: "approved",
      decidedAt: expect.any(String),
      approval: {
        companyGstRegistered: true,
        evidenceVerified: true,
        hasEvidence: true,
        creditableGstCents: "1500",
        nonCreditableGstCents: "0",
        jobCostCents: "15000",
      },
    });
    expect(
      await db.auditEvent.count({
        where: { targetId: body.id, action: "expense.approved" },
      }),
    ).toBe(1);
  });

  it("issue fixture: non-creditable (no receipt above 8250) → cost $165", async () => {
    const body = await approved();
    expect(body.approval).toMatchObject({
      hasEvidence: false,
      creditableGstCents: "0",
      nonCreditableGstCents: "1500",
      jobCostCents: "16500",
    });
  });

  it("before GST registration nothing is claimable; low-value needs retained evidence", async () => {
    const early = await approved({
      purchasedOn: "2019-12-31",
      receiptDocumentId: (await receipt("manager", "tax_invoice")).id,
    });
    expect(early.approval).toMatchObject({
      companyGstRegistered: false,
      jobCostCents: "16500",
    });
    const low = await approved({
      amountCents: "8250",
      priceEntry: "inclusive",
      receiptDocumentId: (await receipt("manager")).id,
    });
    expect(low.approval).toMatchObject({
      hasEvidence: true,
      creditableGstCents: "750",
      jobCostCents: "7500",
    });
    const lowWithout = await approved({
      amountCents: "8250",
      priceEntry: "inclusive",
    });
    expect(lowWithout.approval).toMatchObject({
      hasEvidence: false,
      creditableGstCents: "0",
      jobCostCents: "8250",
    });
    const share = await approved({
      creditablePercent: "60",
      receiptDocumentId: (await receipt("manager", "tax_invoice")).id,
    });
    expect(share.approval).toMatchObject({
      creditableGstCents: "900",
      jobCostCents: "15600",
    });
  });

  it("unapproved and rejected expenses are not incurred cost", async () => {
    const { body: pending } = await submit();
    const { body: rejectedDraft } = await submit();
    const rejected = await (await decide(rejectedDraft.id, "reject")).json();
    expect(rejected).toMatchObject({ status: "rejected", approval: null });
    for (const id of [pending.id, rejected.id]) {
      const row = await db.expense.findUniqueOrThrow({ where: { id } });
      expect(row.jobCostCents).toBeNull();
    }
  });

  it("decides once, even concurrently", async () => {
    const { body } = await submit();
    const results = await Promise.all([
      decide(body.id, "approve"),
      decide(body.id, "approve"),
      decide(body.id, "reject"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(
      await db.auditEvent.count({
        where: {
          targetId: body.id,
          action: { in: ["expense.approved", "expense.rejected"] },
        },
      }),
    ).toBe(1);
  });

  it("evidence is verified, never inferred (Codex #117 review)", async () => {
    // Above 8250: a generic receipt, even verified, is not a tax invoice.
    const generic = await approved({
      receiptDocumentId: (await receipt("manager", "receipt")).id,
    });
    expect(generic.approval).toMatchObject({
      evidenceVerified: true,
      hasEvidence: false,
      jobCostCents: "16500",
    });
    // A tax invoice the approver didn't verify doesn't qualify either.
    const unverified = await approved(
      { receiptDocumentId: (await receipt("manager", "tax_invoice")).id },
      false,
    );
    expect(unverified.approval).toMatchObject({
      evidenceVerified: false,
      hasEvidence: false,
      jobCostCents: "16500",
    });
    // Verifying with nothing attached is refused, and nothing is approved.
    const { body } = await submit();
    const refused = await decide(body.id, "approve", "manager", {
      evidenceVerified: true,
    });
    expect(refused.status).toBe(400);
    expect(
      (await db.expense.findUniqueOrThrow({ where: { id: body.id } })).status,
    ).toBe("submitted");
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { targetId: unverified.id, action: "expense.approved" },
    });
    expect(audit.metadata).toMatchObject({
      changes: { evidenceVerified: { after: false } },
    });
  });
});

describe("approved expenses are final; corrections are reversals", () => {
  it("refuses edits through the API and the database", async () => {
    const body = await approved();
    const edit = await r().update(
      call("manager", "PATCH", { amountCents: "1" }),
      one(body.id),
    );
    expect(edit.status).toBe(409);
    await expect(
      db.expense.update({
        where: { id: body.id },
        data: { description: "silently changed" },
      }),
    ).rejects.toThrow(/record a reversal/);
    await expect(db.expense.delete({ where: { id: body.id } })).rejects.toThrow(
      /never deleted/,
    );
    // Deciding a submitted one can't change what was submitted.
    const { body: draft } = await submit();
    await expect(
      db.expense.update({
        where: { id: draft.id },
        data: {
          status: "rejected",
          decidedAt: new Date(),
          decidedBy: userIds.manager,
          exclusiveCents: 1n,
          inclusiveCents: 1501n,
        },
      }),
    ).rejects.toThrow(/can't change it/);
  });

  it("only the submitter edits a submitted expense, audited field by field", async () => {
    const { body } = await submit({}, "employee");
    expect(
      (
        await r().update(
          call("manager", "PATCH", { description: "x" }),
          one(body.id),
        )
      ).status,
    ).toBe(404);
    const edited = await r().update(
      call("employee", "PATCH", { amountCents: "20000" }),
      one(body.id),
    );
    expect(await edited.json()).toMatchObject({
      exclusiveCents: "20000",
      gstCents: "2000",
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { targetId: body.id, action: "expense.updated" },
    });
    expect(audit.metadata).toMatchObject({
      changes: { exclusiveCents: { before: "15000", after: "20000" } },
    });
  });

  it("reverses an approved expense with its exact negated cents, once", async () => {
    const original = await approved({
      creditablePercent: "33.33",
      receiptDocumentId: (await receipt("manager", "tax_invoice")).id,
    });
    const response = await r().reverse(
      call("manager", "POST", { note: "Wrong job" }),
      one(original.id),
    );
    expect(response.status).toBe(201);
    const reversal = await response.json();
    expect(reversal).toMatchObject({
      reversesId: original.id,
      status: "approved",
      exclusiveCents: "-15000",
      gstCents: "-1500",
      inclusiveCents: "-16500",
      decisionNote: "Wrong job",
      // A cost correction is not a refund.
      settlement: null,
      paidOn: null,
      paymentMethod: null,
    });
    for (const key of [
      "creditableGstCents",
      "nonCreditableGstCents",
      "jobCostCents",
    ] as const) {
      expect(
        BigInt(original.approval[key]) + BigInt(reversal.approval[key]),
        key,
      ).toBe(0n);
    }
    expect(
      (
        await r().reverse(
          call("manager", "POST", { note: "Again" }),
          one(original.id),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await r().reverse(
          call("manager", "POST", { note: "Of a reversal" }),
          one(reversal.id),
        )
      ).status,
    ).toBe(409);
    const { body: draft } = await submit();
    expect(
      (
        await r().reverse(
          call("manager", "POST", { note: "Early" }),
          one(draft.id),
        )
      ).status,
    ).toBe(409);
    expect(
      (await r().reverse(call("manager", "POST", {}), one(original.id))).status,
    ).toBe(400);
    const office = await (
      await r().read(call("accountant", "GET"), one(original.id))
    ).json();
    expect(office.reversedById).toBe(reversal.id);
  });
});

describe("settlement reconciles without double-counting", () => {
  it("paid at purchase vs on account: same cost; cash and outstanding sum to the total", async () => {
    const job = await db.job.create({
      data: {
        companyId,
        customerId: (
          await db.customer.findFirstOrThrow({ where: { companyId } })
        ).id,
        number: 99,
        reference: "SJ-99",
        title: "Settlement job",
        createdBy: userIds.owner,
      },
    });
    const doc = async () => (await receipt("manager", "tax_invoice")).id;
    const paid = await approved({
      jobId: job.id,
      receiptDocumentId: await doc(),
    });
    const onAccount = await approved({
      jobId: job.id,
      settlement: "on_account",
      paymentMethod: undefined,
      receiptDocumentId: await doc(),
    });
    const toReverse = await approved({
      jobId: job.id,
      settlement: "on_account",
      paymentMethod: undefined,
      receiptDocumentId: await doc(),
    });
    // An explicit supplier credit cancels the duplicate's balance.
    await r().reverse(
      call("manager", "POST", {
        note: "Duplicate",
        settlement: "supplier_credit",
      }),
      one(toReverse.id),
    );
    await submit({ jobId: job.id }); // pending: no cost, no cash, no balance
    const rows = await db.expense.findMany({
      where: { companyId, jobId: job.id, status: "approved" },
    });
    const sum = (pick: (row: (typeof rows)[number]) => bigint) =>
      rows.reduce((total, row) => total + pick(row), 0n);
    const cost = sum((row) => row.jobCostCents ?? 0n);
    const cash = sum((row) =>
      row.settlement === "paid_at_purchase" ? row.inclusiveCents : 0n,
    );
    const outstanding = sum((row) =>
      row.settlement === "on_account" ? row.inclusiveCents : 0n,
    );
    expect({ cost, cash, outstanding }).toEqual({
      cost: 30000n,
      cash: 16500n,
      outstanding: 16500n,
    });
    expect(cash + outstanding).toBe(sum((row) => row.inclusiveCents));
    expect(paid.approval.jobCostCents).toBe(onAccount.approval.jobCostCents);
  });
});

describe("reversals move cash only when a refund is recorded (Codex #117 review)", () => {
  const cashFor = async (id: string) => {
    const rows = await db.expense.findMany({
      where: { OR: [{ id }, { reversesId: id }] },
    });
    return rows.reduce(
      (total, row) =>
        total +
        (row.settlement === "paid_at_purchase" ? row.inclusiveCents : 0n),
      0n,
    );
  };

  it("a correction without a refund leaves the payment as it was", async () => {
    const paid = await approved();
    const reversal = await r().reverse(
      call("manager", "POST", { note: "Wrong category" }),
      one(paid.id),
    );
    expect(reversal.status).toBe(201);
    expect(await cashFor(paid.id)).toBe(16500n);
  });

  it("an actual refund needs its date and moves cash back", async () => {
    const paid = await approved();
    const missingDate = await r().reverse(
      call("manager", "POST", { note: "Returned", settlement: "refund" }),
      one(paid.id),
    );
    expect(missingDate.status).toBe(400);
    const refunded = await r().reverse(
      call("manager", "POST", {
        note: "Returned",
        settlement: "refund",
        refundedOn: "2026-07-03",
      }),
      one(paid.id),
    );
    expect(await refunded.json()).toMatchObject({
      settlement: "paid_at_purchase",
      paidOn: "2026-07-03",
      paymentMethod: "card",
    });
    expect(await cashFor(paid.id)).toBe(0n);
  });

  it("refunds only paid expenses and credits only on-account ones", async () => {
    const onAccount = await approved({
      settlement: "on_account",
      paymentMethod: undefined,
    });
    expect(
      (
        await r().reverse(
          call("manager", "POST", {
            note: "x",
            settlement: "refund",
            refundedOn: "2026-07-03",
          }),
          one(onAccount.id),
        )
      ).status,
    ).toBe(400);
    const paid = await approved();
    expect(
      (
        await r().reverse(
          call("manager", "POST", { note: "x", settlement: "supplier_credit" }),
          one(paid.id),
        )
      ).status,
    ).toBe(400);
  });
});

describe("eligibility is rechecked under the shared locks (Codex #117 review)", () => {
  it("writes nothing when the assignment ends while the submission waits", async () => {
    const employee = await db.employee.findFirstOrThrow({
      where: { companyId, userId: userIds.employee },
    });
    const job = await db.job.create({
      data: {
        companyId,
        customerId: (
          await db.customer.findFirstOrThrow({ where: { companyId } })
        ).id,
        number: 77,
        reference: "SJ-77",
        title: "Race job",
        createdBy: userIds.owner,
      },
    });
    const assignment = await db.assignment.create({
      data: {
        companyId,
        jobId: job.id,
        employeeId: employee.id,
        createdBy: userIds.owner,
      },
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let pending: Promise<Response> | undefined;
    // An unassign that holds the job lock (as #32's end does) while the
    // employee's submission arrives, then commits.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { endedAt: new Date(), endedBy: userIds.owner },
      });
      locked();
      pending = r().create(
        call("employee", "POST", { jobId: job.id, ...MATERIALS }),
        undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await holding;
    const response = await pending!;
    expect(response.status).toBe(400);
    expect(await db.expense.count({ where: { jobId: job.id } })).toBe(0);
    expect(
      await db.auditEvent.count({
        where: {
          action: "expense.submitted",
          metadata: { path: ["changes", "jobId", "after"], equals: job.id },
        },
      }),
    ).toBe(0);
  });
});

describe("corrections reuse the original settlement (Codex #117 review, P1)", () => {
  /** Domain totals over an original, its reversal and its correction. */
  async function chainTotals(originalId: string) {
    const rows = await db.expense.findMany({
      where: {
        status: "approved",
        OR: [
          { id: originalId },
          { reversesId: originalId },
          { correctsId: originalId },
        ],
      },
    });
    return expenseTotals(
      rows.map((row) => ({
        settlement: row.settlement,
        inclusive: row.inclusiveCents,
        jobCost: row.jobCostCents ?? 0n,
        creditableGst: row.creditableGstCents ?? 0n,
      })),
    );
  }
  const reverseCostOnly = (id: string) =>
    r().reverse(
      call("manager", "POST", { note: "Missing tax invoice" }),
      one(id),
    );
  const correct = (id: string, body: Record<string, unknown> = {}) =>
    submit({ correctsExpenseId: id, ...body });

  it("paid original → cost-only reversal → correction → approval: one $165 payment, corrected cost/GST", async () => {
    // Approved without verified evidence: GST not creditable, cost $165.
    const original = await approved();
    expect(original.approval.jobCostCents).toBe("16500");
    expect((await reverseCostOnly(original.id)).status).toBe(201);
    // The tax invoice turns up: correct with verified evidence.
    const invoice = await receipt("manager", "tax_invoice");
    const { response, body } = await correct(original.id, {
      receiptDocumentId: invoice.id,
    });
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      correctsId: original.id,
      settlement: null,
      paidOn: null,
      paymentMethod: null,
    });
    expect(
      (await decide(body.id, "approve", "manager", { evidenceVerified: true }))
        .status,
    ).toBe(200);
    expect(await chainTotals(original.id)).toEqual({
      cost: 15000n, // 16500 - 16500 + 15000
      creditableGst: 1500n,
      cashPaid: 16500n, // the one real payment, never doubled
      supplierOutstanding: 0n, // no invented payable
    });
  });

  it("on-account original → reversal → correction: one $165 supplier balance, no payment", async () => {
    const original = await approved({
      settlement: "on_account",
      paymentMethod: null,
    });
    await reverseCostOnly(original.id);
    const invoice = await receipt("manager", "tax_invoice");
    const { body } = await correct(original.id, {
      receiptDocumentId: invoice.id,
      settlement: "on_account",
      paymentMethod: null,
    });
    await decide(body.id, "approve", "manager", { evidenceVerified: true });
    expect(await chainTotals(original.id)).toEqual({
      cost: 15000n,
      creditableGst: 1500n,
      cashPaid: 0n,
      supplierOutstanding: 16500n,
    });
  });

  it("refuses corrections that would invent or lose money, or double up", async () => {
    const original = await approved();
    // Not reversed yet.
    expect((await correct(original.id)).response.status).toBe(409);
    await reverseCostOnly(original.id);
    // A different paid total is a refund or a separate expense, not a correction.
    expect(
      (await correct(original.id, { amountCents: "14000" })).response.status,
    ).toBe(400);
    // One correction per original.
    expect((await correct(original.id)).response.status).toBe(201);
    expect((await correct(original.id)).response.status).toBe(409);

    // A refunded original isn't corrected through this path.
    const refunded = await approved();
    await r().reverse(
      call("manager", "POST", {
        note: "Returned",
        settlement: "refund",
        refundedOn: "2026-07-03",
      }),
      one(refunded.id),
    );
    expect((await correct(refunded.id)).response.status).toBe(409);
  });

  it("a rejected correction stays as history and a new one can follow: reject → resubmit → approve", async () => {
    const original = await approved();
    await reverseCostOnly(original.id);
    const first = (await correct(original.id)).body;
    expect(
      (await decide(first.id, "reject", "manager", { note: "Wrong supplier" }))
        .status,
    ).toBe(200);
    // The rejected correction no longer blocks a retry.
    const invoice = await receipt("manager", "tax_invoice");
    const second = await correct(original.id, {
      receiptDocumentId: invoice.id,
    });
    expect(second.response.status).toBe(201);
    // But only one live correction at a time.
    expect((await correct(original.id)).response.status).toBe(409);
    expect(
      (
        await decide(second.body.id, "approve", "manager", {
          evidenceVerified: true,
        })
      ).status,
    ).toBe(200);
    // History: both corrections exist; exactly one is live.
    const corrections = await db.expense.findMany({
      where: { correctsId: original.id },
      orderBy: { createdAt: "asc" },
    });
    expect(corrections.map((row) => row.status)).toEqual([
      "rejected",
      "approved",
    ]);
    expect(await chainTotals(original.id)).toEqual({
      cost: 15000n,
      creditableGst: 1500n,
      cashPaid: 16500n, // still one payment
      supplierOutstanding: 0n,
    });
    const view = await (
      await r().read(call("manager", "GET"), one(original.id))
    ).json();
    expect(view.correctedById).toBe(second.body.id);
  });

  it("only the office can correct, and corrections can't be edited", async () => {
    const original = await approved();
    await reverseCostOnly(original.id);
    const { body } = await correct(original.id);
    const edit = await r().update(
      call("manager", "PATCH", { description: "changed" }),
      one(body.id),
    );
    expect(edit.status).toBe(409);
    const byWorker = await r().create(
      call("employee", "POST", {
        jobId: assignedJobId,
        ...MATERIALS,
        correctsExpenseId: original.id,
      }),
      undefined,
    );
    expect(byWorker.status).toBe(400);
  });
});

describe("decision guard freezes the GST-rate snapshot (Codex #117 review, P2)", () => {
  it("refuses a decision that also changes the rate snapshot", async () => {
    const { body } = await submit();
    await expect(
      db.expense.update({
        where: { id: body.id },
        data: {
          status: "rejected",
          decidedAt: new Date(),
          decidedBy: userIds.manager,
          gstRateBasisPoints: 0,
        },
      }),
    ).rejects.toThrow(/deciding an expense can't change it/);
  });
});
