import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { invoiceHandlers } from "../../apps/web/src/server/invoices/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #47: customer tax invoices — GST lines, validation before issue,
// numbering at issue, immutability, credit notes and voids.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "plainowner",
  "outsider",
] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof invoiceHandlers>;
let companyId = "";
let plainCompanyId = "";
let customerId = "";
let siteId = "";
let jobId = "";
let plainCustomerId = "";
let outsiderInvoiceId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x4747);

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
  handlers = invoiceHandlers(() => db);
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
  const plain = factory.company(userIds.plainowner);
  const other = factory.company(userIds.outsider);
  for (const [record, owner] of [
    [own, userIds.owner],
    [plain, userIds.plainowner],
    [other, userIds.outsider],
  ] as const) {
    await db.$transaction(async (tx) => {
      await tx.company.create({ data: { ...record, invoicePrefix: "SI-" } });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  }
  companyId = own.id;
  plainCompanyId = plain.id;
  await db.company.update({
    where: { id: companyId },
    data: {
      legalName: "Sample Contracting Pty Ltd",
      abn: syntheticAbn("470000001"),
    },
  });
  await db.companyGstRegistration.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      startsOn: new Date("2025-07-01T00:00:00Z"),
      basis: "cash",
    },
  });
  for (const role of ["manager", "accountant", "employee"] as const) {
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[role],
        createdBy: userIds.owner,
        role,
      },
    });
  }
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
    })
  ).id;
  siteId = (
    await db.location.create({
      data: {
        companyId,
        customerId,
        createdBy: userIds.owner,
        label: "Depot",
        addressLine1: "1 Sample Street",
        suburb: "Sampleton",
        state: "NSW",
        postcode: "2000",
      },
    })
  ).id;
  jobId = (
    await db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId,
        number: 1,
        reference: "JOB-0001",
        title: "Switchboard",
        status: "completed",
      },
    })
  ).id;
  plainCustomerId = (
    await db.customer.create({
      data: {
        companyId: plainCompanyId,
        createdBy: userIds.plainowner,
        name: "Plain Client",
      },
    })
  ).id;
  const otherCustomer = await db.customer.create({
    data: {
      companyId: other.id,
      createdBy: userIds.outsider,
      name: "Theirs",
    },
  });
  outsiderInvoiceId = (
    await db.invoice.create({
      data: {
        companyId: other.id,
        customerId: otherCustomer.id,
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

function call(who: Who, method: string, body?: unknown, query = ""): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/invoices${query}`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  list: withPolicy("invoice.read", handlers.list),
  read: withPolicy("invoice.read", handlers.read),
  create: withPolicy("invoice.write", handlers.create),
  update: withPolicy("invoice.write", handlers.update),
  discard: withPolicy("invoice.write", handlers.discard),
  issue: withPolicy("invoice.issue", handlers.issue),
  credit: withPolicy("invoice.issue", handlers.credit),
  void: withPolicy("invoice.issue", handlers.void),
});

const INSTALL = {
  description: "Switchboard upgrade",
  quantity: "1",
  unit: "each",
  unitPriceCents: "250000",
  taxCode: "TAXABLE_10",
};

async function draft(
  body: Record<string, unknown> = {},
  who: Who = "accountant",
) {
  const response = await r().create(
    call(who, "POST", { customerId, lines: [INSTALL], ...body }),
    undefined,
  );
  return { response, body: await response.json() };
}
const issue = (id: string, who: Who = "accountant", body: unknown = {}) =>
  r().issue(call(who, "POST", body), one(id));

describe("issuing a tax invoice", () => {
  it("fixture: $2,500 ex GST → $250 GST → $2,750, 'Tax Invoice', numbered and snapshotted", async () => {
    const { response, body } = await draft({
      jobId,
      locationId: siteId,
      customerReference: "PO-7731",
    });
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      status: "draft",
      number: null,
      exclusiveCents: "250000",
      gstCents: "25000",
      inclusiveCents: "275000",
    });
    const issued = await issue(body.id, "accountant", {
      issueDate: "2026-07-01",
    });
    expect(issued.status).toBe(200);
    expect(await issued.json()).toMatchObject({
      status: "issued",
      title: "Tax Invoice",
      reference: "SI-0001",
      issueDate: "2026-07-01",
      gstRegistered: true,
      customerReference: "PO-7731",
      exclusiveCents: "250000",
      gstCents: "25000",
      inclusiveCents: "275000",
      supplier: { legalName: "Sample Contracting Pty Ltd" },
      customer: { name: "Acme Sample" },
      site: { label: "Depot", addressLine1: "1 Sample Street" },
      lines: [
        expect.objectContaining({ unit: "each", gstRateBasisPoints: 1000 }),
      ],
    });
    // The completed job becomes invoiced, recorded in its history.
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status,
    ).toBe("invoiced");
    expect(
      await db.jobStatusEvent.count({ where: { jobId, toStatus: "invoiced" } }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "invoice.issued" },
      }),
    ).toBe(1);
  });

  it("re-prices against registration on the issue date: before registration, Taxable is refused", async () => {
    const { body } = await draft();
    const early = await issue(body.id, "accountant", {
      issueDate: "2025-06-30",
    });
    expect(early.status).toBe(400);
    expect(Object.keys((await early.json()).fields)).toEqual([
      "lines.0.taxCode",
    ]);
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: body.id } })).status,
    ).toBe("draft");
  });

  it("not registered → no GST and titled 'Invoice'", async () => {
    const created = await r().create(
      call("plainowner", "POST", {
        customerId: plainCustomerId,
        lines: [{ ...INSTALL, taxCode: "OUT_OF_SCOPE" }],
      }),
      undefined,
    );
    const body = await created.json();
    const issued = await (await issue(body.id, "plainowner")).json();
    expect(issued).toMatchObject({
      title: "Invoice",
      gstRegistered: false,
      gstCents: "0",
      inclusiveCents: "250000",
    });
    // A Taxable line can't be issued by an unregistered company.
    const taxable = await (
      await r().create(
        call("plainowner", "POST", {
          customerId: plainCustomerId,
          lines: [INSTALL],
        }),
        undefined,
      )
    ).json();
    expect((await issue(taxable.id, "plainowner")).status).toBe(400);
  });

  it("validates before issue: legal name/ABN, at least one line, no future date", async () => {
    const empty = (await draft({ lines: [] })).body;
    expect(Object.keys((await (await issue(empty.id)).json()).fields)).toEqual([
      "lines",
    ]);
    expect(
      (
        await issue((await draft()).body.id, "accountant", {
          issueDate: "2999-01-01",
        })
      ).status,
    ).toBe(400);
    await db.company.update({ where: { id: companyId }, data: { abn: null } });
    try {
      const noAbn = (await draft()).body;
      expect(
        Object.keys((await (await issue(noAbn.id)).json()).fields),
      ).toEqual(["company.abn"]);
    } finally {
      await db.company.update({
        where: { id: companyId },
        data: { abn: syntheticAbn("470000001") },
      });
    }
  });

  it("mixed tax codes and inclusive entry, rounded per line", async () => {
    const { body } = await draft({
      priceEntry: "inclusive",
      lines: [
        { ...INSTALL, quantity: "2.5", unitPriceCents: "11000" },
        {
          ...INSTALL,
          description: "Fee",
          unitPriceCents: "333",
          quantity: "3",
          taxCode: "GST_FREE",
        },
      ],
    });
    const issued = await (await issue(body.id)).json();
    expect(issued).toMatchObject({
      exclusiveCents: "25999",
      gstCents: "2500",
      inclusiveCents: "28499",
    });
  });
});

describe("issued invoices are immutable", () => {
  it("refuses edits, discards and line changes through the API and the database", async () => {
    const { body } = await draft();
    await issue(body.id);
    expect(
      (
        await r().update(
          call("accountant", "PATCH", { notes: "x" }),
          one(body.id),
        )
      ).status,
    ).toBe(409);
    expect(
      (await r().discard(call("accountant", "DELETE"), one(body.id))).status,
    ).toBe(409);
    await expect(
      db.invoice.update({
        where: { id: body.id },
        data: { inclusiveCents: 1n },
      }),
    ).rejects.toThrow(/can't be edited/);
    await expect(db.invoice.delete({ where: { id: body.id } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      db.invoiceItem.updateMany({
        where: { invoiceId: body.id },
        data: { description: "changed" },
      }),
    ).rejects.toThrow(/can't change/);
  });

  it("lets a draft be edited and discarded", async () => {
    const { body } = await draft();
    const edited = await r().update(
      call("accountant", "PATCH", {
        lines: [{ ...INSTALL, unitPriceCents: "100000" }],
        notes: "Thanks",
      }),
      one(body.id),
    );
    expect(await edited.json()).toMatchObject({
      inclusiveCents: "110000",
      notes: "Thanks",
    });
    expect(
      (await r().discard(call("accountant", "DELETE"), one(body.id))).status,
    ).toBe(200);
    expect(await db.invoice.count({ where: { id: body.id } })).toBe(0);
  });
});

describe("numbering", () => {
  it("never duplicates a number when many invoices are issued in parallel", async () => {
    const drafts = await Promise.all(
      Array.from({ length: 10 }, () =>
        draft().then(({ body }) => body.id as string),
      ),
    );
    const results = await Promise.all(drafts.map((id) => issue(id)));
    expect(results.every((response) => response.status === 200)).toBe(true);
    const numbers = (
      await db.invoice.findMany({
        where: { companyId, kind: "invoice", status: { not: "draft" } },
        select: { number: true },
      })
    ).map((row) => row.number!);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: numbers.length }, (_, i) => i + 1),
    );
  });
});

describe("credit notes and voids", () => {
  it("credits up to the invoice total, as an 'Adjustment Note' with its own numbers", async () => {
    const invoice = (await draft()).body;
    await issue(invoice.id);
    const partial = await r().credit(
      call("accountant", "POST", {
        lines: [
          { ...INSTALL, description: "Discount", unitPriceCents: "100000" },
        ],
      }),
      one(invoice.id),
    );
    expect(partial.status).toBe(201);
    const partialBody = await partial.json();
    expect(partialBody).toMatchObject({
      kind: "credit_note",
      creditsId: invoice.id,
    });
    expect(await (await issue(partialBody.id)).json()).toMatchObject({
      title: "Adjustment Note",
      reference: "CN-0001",
      inclusiveCents: "110000",
    });
    // A full copy would now exceed what's left (275000 - 110000).
    const full = await (
      await r().credit(call("accountant", "POST", {}), one(invoice.id))
    ).json();
    expect(full.inclusiveCents).toBe("275000");
    expect((await issue(full.id)).status).toBe(400);
    // Voiding an invoice that has issued credits is refused.
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Mistake" }),
          one(invoice.id),
        )
      ).status,
    ).toBe(409);
    // Void the credit note, then the invoice can be voided.
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Wrong" }),
          one(partialBody.id),
        )
      ).status,
    ).toBe(200);
    const voided = await r().void(
      call("accountant", "POST", { reason: "Issued to the wrong customer" }),
      one(invoice.id),
    );
    expect(await voided.json()).toMatchObject({
      status: "void",
      voidReason: "Issued to the wrong customer",
    });
    // A void is final, even directly in the database.
    await expect(
      db.invoice.update({
        where: { id: invoice.id },
        data: { status: "issued" },
      }),
    ).rejects.toThrow(/void invoice/);
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "Again" }),
          one(invoice.id),
        )
      ).status,
    ).toBe(409);
  });

  it("only credits and voids issued invoices", async () => {
    const { body } = await draft();
    expect(
      (await r().credit(call("accountant", "POST", {}), one(body.id))).status,
    ).toBe(409);
    expect(
      (
        await r().void(
          call("accountant", "POST", { reason: "x" }),
          one(body.id),
        )
      ).status,
    ).toBe(409);
  });
});

describe("access", () => {
  it("follows the role matrix: managers read only; owner/accountant draft and issue; employees nothing", async () => {
    expect((await r().list(call("manager", "GET"), undefined)).status).toBe(
      200,
    );
    expect((await draft({}, "manager")).response.status).toBe(403);
    const { body } = await draft({}, "owner");
    expect((await issue(body.id, "manager")).status).toBe(403);
    expect((await issue(body.id, "owner")).status).toBe(200);
    expect((await r().list(call("employee", "GET"), undefined)).status).toBe(
      403,
    );
    expect((await draft({}, "employee")).response.status).toBe(403);
  });

  it("isolates tenants and checks the customer, job and site belong together", async () => {
    for (const id of [
      outsiderInvoiceId,
      "00000000-0000-4000-8000-000000000000",
      "x",
    ]) {
      expect((await r().read(call("owner", "GET"), one(id))).status, id).toBe(
        404,
      );
      expect((await issue(id, "owner")).status, id).toBe(404);
    }
    expect((await draft({ customerId: plainCustomerId })).response.status).toBe(
      400,
    );
    const otherCustomer = await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Bravo Sample" },
    });
    expect(
      (await draft({ customerId: otherCustomer.id, locationId: siteId }))
        .response.status,
    ).toBe(400);
    expect(
      (await draft({ customerId: otherCustomer.id, jobId })).response.status,
    ).toBe(400);
  });
});
