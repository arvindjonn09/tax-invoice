import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { billHandlers } from "../../apps/web/src/server/bills/handlers";
import {
  MAX_PENDING,
  billSubmissionHandlers,
} from "../../apps/web/src/server/bills/submissions";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #139: a subcontractor submits their own tax invoice for an accepted
// offer; the office verifies and approves (recording the bill once) or
// rejects. The subcontractor never sees the job price, committed cost or
// any bill snapshot (T03). Fixture: offer for $900 + $90 GST.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = [
  "owner",
  "accountant",
  "employee",
  "sub",
  "otherSub",
  "outsider",
] as const;
type Who = (typeof WHO)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let companyId = "";
let contractorId = "";
let offerId = "";
let jobId = "";
let otherOfferId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x139);
type One = { params: Promise<{ id: string }> };
let routes: ReturnType<typeof makeRoutes>;

function makeRoutes() {
  const s = billSubmissionHandlers(() => db);
  const bills = billHandlers(() => db);
  return {
    submit: withPolicy("bill.submit_own", s.submit),
    mine: withPolicy("bill.submit_own", s.mine),
    list: withPolicy("bill.read", s.list),
    read: withPolicy<One>("bill.read", s.read),
    approve: withPolicy<One>("bill.write", s.approve),
    reject: withPolicy<One>("bill.write", s.reject),
    billRead: withPolicy<One>("bill.read", bills.read),
    bill: withPolicy("bill.write", bills.create),
  };
}
const one = (id: string) => ({ params: Promise.resolve({ id }) });

function call(who: Who, body?: unknown) {
  const h = new Headers(cookies[who]);
  h.set("origin", ORIGIN);
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

async function acceptedOffer(contractor: string, createdBy: string) {
  const offer = await db.contractorOffer.create({
    data: {
      companyId,
      jobId,
      contractorId: contractor,
      scope: "Synthetic wiring",
      rateType: "fixed",
      rateExclusiveCents: 90_000n,
      taxCode: "TAXABLE_10",
      status: "accepted",
      respondedBy: createdBy,
      respondedAt: new Date("2026-07-10T00:00:00Z"),
      createdBy: userIds.owner,
    },
  });
  await db.contractorAcceptance.create({
    data: {
      companyId,
      jobId,
      offerId: offer.id,
      contractorId: contractor,
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
      acceptedAt: new Date("2026-07-10T00:00:00Z"),
      acceptedBy: createdBy,
    },
  });
  return offer.id;
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
        email: `${key.toLowerCase()}@jobflow.invalid`,
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
  await db.companyGstRegistration.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      startsOn: new Date("2025-07-01T00:00:00Z"),
      basis: "non_cash",
    },
  });
  for (const [key, role] of [
    ["accountant", "accountant"],
    ["employee", "employee"],
    ["sub", "subcontractor"],
    ["otherSub", "subcontractor"],
  ] as const)
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[key],
        createdBy: userIds.owner,
        role,
      },
    });
  const customer = await db.customer.create({
    data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
  });
  jobId = (
    await db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId: customer.id,
        number: 1,
        reference: "JOB-139-1",
        title: "Synthetic subcontracted work",
        status: "in_progress",
        agreedPriceExclusiveCents: 250_000n,
      },
    })
  ).id;
  contractorId = (
    await db.contractor.create({
      data: {
        companyId,
        userId: userIds.sub,
        name: "Sample Sparks",
        gstRegistered: true,
        abn: syntheticAbn("139139139"),
        createdBy: userIds.owner,
      },
    })
  ).id;
  const otherContractor = await db.contractor.create({
    data: {
      companyId,
      userId: userIds.otherSub,
      name: "Other Sparks",
      gstRegistered: true,
      abn: syntheticAbn("139139140"),
      createdBy: userIds.owner,
    },
  });
  offerId = await acceptedOffer(contractorId, userIds.sub);
  otherOfferId = await acceptedOffer(otherContractor.id, userIds.otherSub);
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
          email: `${key.toLowerCase()}@jobflow.invalid`,
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

async function upload(who: Who = "sub", kind = "tax_invoice") {
  return (
    await db.document.create({
      data: {
        companyId,
        kind: kind as "tax_invoice",
        objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
        fileName: "synthetic-tax-invoice.pdf",
        contentType: "application/pdf",
        sizeBytes: 1234,
        sha256: "b".repeat(64),
        createdBy: userIds[who],
      },
    })
  ).id;
}

const body = async (overrides: Record<string, unknown> = {}) => ({
  offerId,
  supplierReference: `INV-${randomUUID().slice(0, 8)}`,
  issuedOn: "2026-07-20",
  lines: [
    {
      description: "Synthetic wiring",
      taxCode: "TAXABLE_10",
      exclusiveCents: "90000",
      gstCents: "9000",
    },
  ],
  documentId: await upload(),
  ...overrides,
});

/** No job price, committed cost, profit or bill snapshot, anywhere. */
function expectNoCompanyMoney(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const key of [
    "agreedPrice",
    "committedCost",
    "jobCost",
    "creditableGst",
    "profit",
    "billId",
    "250000",
  ])
    expect(text).not.toContain(key);
}

describe("subcontractor bills (#139)", () => {
  it("a subcontractor submits their own invoice; the office approves it into one bill", async () => {
    const submitted = await routes.submit(call("sub", await body()), undefined);
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    const own = (await submitted.json()) as { id: string; status: string };
    expect(own).toMatchObject({
      status: "submitted",
      totalCents: "99000",
      job: { reference: "JOB-139-1" },
    });
    expectNoCompanyMoney(own);
    const mine = await (await routes.mine(call("sub"), undefined)).json();
    expect(mine.submissions.map((s: { id: string }) => s.id)).toContain(own.id);
    expectNoCompanyMoney(mine);

    const queue = await (
      await routes.list(call("accountant"), undefined)
    ).json();
    expect(queue.submissions.map((s: { id: string }) => s.id)).toContain(
      own.id,
    );

    const approved = await routes.approve(
      call("accountant", { evidenceVerified: true }),
      one(own.id),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    const decided = (await approved.json()) as { billId: string };
    const bill = await (
      await routes.billRead(call("accountant"), one(decided.billId))
    ).json();
    // The #46 snapshot: contractor's details, offer link, cost recorded once.
    expect(bill).toMatchObject({
      contractorId,
      offerId,
      jobId,
      supplierName: "Sample Sparks",
      inclusiveCents: "99000",
      creditableGstCents: "9000",
      jobCostCents: "90000",
      evidenceVerified: true,
    });
    expect(await db.supplierBill.count({ where: { companyId, offerId } })).toBe(
      1,
    );
    // Decided once.
    expect(
      (
        await routes.approve(
          call("accountant", { evidenceVerified: true }),
          one(own.id),
        )
      ).status,
    ).toBe(409);
    // The subcontractor sees "approved", still without the snapshot.
    const after = await (await routes.mine(call("sub"), undefined)).json();
    const row = after.submissions.find((s: { id: string }) => s.id === own.id);
    expect(row.status).toBe("approved");
    expectNoCompanyMoney(after);
    // Its invoice number can't be submitted again once recorded.
    const again = await routes.submit(
      call(
        "sub",
        await body({
          supplierReference: (row as { supplierReference: string })
            .supplierReference,
        }),
      ),
      undefined,
    );
    expect(again.status).toBe(409);
  });

  it("rejection says why and the subcontractor can resubmit", async () => {
    const reference = `INV-${randomUUID().slice(0, 8)}`;
    const first = (await (
      await routes.submit(
        call("sub", await body({ supplierReference: reference })),
        undefined,
      )
    ).json()) as { id: string };
    // One pending submission per invoice number.
    expect(
      (
        await routes.submit(
          call(
            "sub",
            await body({ supplierReference: reference.toLowerCase() }),
          ),
          undefined,
        )
      ).status,
    ).toBe(409);
    expect(
      (await routes.reject(call("accountant", {}), one(first.id))).status,
    ).toBe(400);
    const rejected = await routes.reject(
      call("accountant", { note: "Your ABN is missing from the invoice" }),
      one(first.id),
    );
    expect(rejected.status).toBe(200);
    const mine = await (await routes.mine(call("sub"), undefined)).json();
    expect(
      mine.submissions.find((s: { id: string }) => s.id === first.id),
    ).toMatchObject({
      status: "rejected",
      decisionNote: "Your ABN is missing from the invoice",
    });
    expect(
      (
        await routes.submit(
          call("sub", await body({ supplierReference: reference })),
          undefined,
        )
      ).status,
    ).toBe(201);
  });

  it("refuses other people's offers, documents and invalid invoices", async () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ offerId: otherOfferId }, 400], // another subcontractor's offer
      [{ offerId: randomUUID() }, 400],
      [{ documentId: await upload("accountant") }, 400], // not their upload
      [{ documentId: await upload("sub", "photo") }, 400],
      [{ issuedOn: "2999-01-01" }, 400],
      [
        {
          lines: [
            {
              description: "Bad GST",
              taxCode: "TAXABLE_10",
              exclusiveCents: "90000",
              gstCents: "1",
            },
          ],
        },
        400,
      ],
    ];
    for (const [overrides, status] of cases)
      expect(
        (await routes.submit(call("sub", await body(overrides)), undefined))
          .status,
        JSON.stringify(overrides),
      ).toBe(status);
    // A document already in a submission can't back an office bill.
    const doc = await upload();
    expect(
      (
        await routes.submit(
          call("sub", await body({ documentId: doc })),
          undefined,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await routes.submit(
          call("sub", await body({ documentId: doc })),
          undefined,
        )
      ).status,
    ).toBe(400);
  });

  it("only subcontractors submit; only the office reads and decides; other tenants see nothing", async () => {
    // Only subcontractors have bill.submit_own; the owner (all permissions)
    // has no contractor profile of their own, so it's not found.
    expect(
      (await routes.submit(call("owner", await body()), undefined)).status,
    ).toBe(404);
    for (const who of ["accountant", "employee"] as const)
      expect(
        (await routes.submit(call(who, await body()), undefined)).status,
        who,
      ).toBe(403);
    const pending = (await (
      await routes.submit(call("sub", await body()), undefined)
    ).json()) as { id: string };
    for (const who of ["sub", "otherSub", "employee"] as const) {
      expect((await routes.list(call(who), undefined)).status, who).toBe(403);
      expect(
        (
          await routes.approve(
            call(who, { evidenceVerified: true }),
            one(pending.id),
          )
        ).status,
        who,
      ).toBe(403);
    }
    // Another subcontractor never sees it.
    const theirs = await (
      await routes.mine(call("otherSub"), undefined)
    ).json();
    expect(theirs.submissions.map((s: { id: string }) => s.id)).not.toContain(
      pending.id,
    );
    // Another company's office gets 404.
    expect((await routes.read(call("outsider"), one(pending.id))).status).toBe(
      404,
    );
  });

  it("submissions are decided once and never deleted (database)", async () => {
    const pending = (await (
      await routes.submit(call("sub", await body()), undefined)
    ).json()) as { id: string };
    await expect(
      db.subcontractorBillSubmission.update({
        where: { id: pending.id },
        data: { supplierReference: "EDITED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.subcontractorBillSubmission.delete({ where: { id: pending.id } }),
    ).rejects.toThrow();
    await expect(
      db.subcontractorBillSubmissionItem.updateMany({
        where: { submissionId: pending.id },
        data: { exclusiveCents: 1n },
      }),
    ).rejects.toThrow();
    await routes.reject(call("owner", { note: "Synthetic" }), one(pending.id));
    await expect(
      db.subcontractorBillSubmission.update({
        where: { id: pending.id },
        data: { status: "submitted" },
      }),
    ).rejects.toThrow();
  });

  it("a submitted document can't back an office bill; the office sees agreed and billed amounts", async () => {
    const doc = await upload();
    const submitted = (await (
      await routes.submit(
        call("sub", await body({ documentId: doc })),
        undefined,
      )
    ).json()) as { id: string };
    const office = await routes.bill(
      call("accountant", {
        contractorId,
        offerId,
        supplierReference: `OFFICE-${randomUUID().slice(0, 8)}`,
        issuedOn: "2026-07-20",
        lines: [
          {
            description: "Synthetic",
            taxCode: "TAXABLE_10",
            exclusiveCents: "1000",
            gstCents: "100",
          },
        ],
        documentId: doc,
        evidenceVerified: true,
      }),
      undefined,
    );
    expect(office.status).toBe(400);
    const read = await (
      await routes.read(call("accountant"), one(submitted.id))
    ).json();
    expect(read.offer).toMatchObject({ agreedInclusiveCents: "99000" });
    expect(BigInt(read.offer.billedInclusiveCents)).toBeGreaterThanOrEqual(0n);
  });

  it("approval loses cleanly to an office bill for the same invoice, and to a concurrent approval", async () => {
    const reference = `INV-${randomUUID().slice(0, 8)}`;
    const raced = (await (
      await routes.submit(
        call("sub", await body({ supplierReference: reference })),
        undefined,
      )
    ).json()) as { id: string };
    const recorded = await routes.bill(
      call("accountant", {
        contractorId,
        offerId,
        supplierReference: reference,
        issuedOn: "2026-07-20",
        lines: [
          {
            description: "Synthetic",
            taxCode: "TAXABLE_10",
            exclusiveCents: "1000",
            gstCents: "100",
          },
        ],
      }),
      undefined,
    );
    expect(recorded.status, await recorded.clone().text()).toBe(201);
    const before = await db.supplierBill.count({ where: { companyId } });
    expect(
      (
        await routes.approve(
          call("accountant", { evidenceVerified: true }),
          one(raced.id),
        )
      ).status,
    ).toBe(409);
    expect(await db.supplierBill.count({ where: { companyId } })).toBe(before);
    expect(
      (
        await db.subcontractorBillSubmission.findUniqueOrThrow({
          where: { id: raced.id },
        })
      ).status,
    ).toBe("submitted");

    const twice = (await (
      await routes.submit(call("sub", await body()), undefined)
    ).json()) as { id: string };
    const results = await Promise.all(
      [0, 1].map(() =>
        routes.approve(
          call("accountant", { evidenceVerified: true }),
          one(twice.id),
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await db.supplierBill.count({
        where: { companyId, submission: { id: twice.id } },
      }),
    ).toBe(1);
  });

  it("re-checks GST at approval, keeps the approval note internal, and checks the due date", async () => {
    const pending = (await (
      await routes.submit(call("sub", await body()), undefined)
    ).json()) as { id: string };
    expect(
      (
        await routes.approve(
          call("accountant", { evidenceVerified: true, dueOn: "2026-07-01" }),
          one(pending.id),
        )
      ).status,
    ).toBe(400);
    await db.contractor.update({
      where: { id: contractorId },
      data: { gstRegistered: false },
    });
    try {
      const refused = await routes.approve(
        call("accountant", { evidenceVerified: true }),
        one(pending.id),
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        fields: { "lines.0": expect.any(String) },
      });
      // The subcontractor is told their registration, so they can resend.
      const mine = await (await routes.mine(call("sub"), undefined)).json();
      expect(mine.gstRegistered).toBe(false);
    } finally {
      await db.contractor.update({
        where: { id: contractorId },
        data: { gstRegistered: true },
      });
    }
    const approved = await routes.approve(
      call("accountant", {
        evidenceVerified: true,
        note: "Internal: over budget, margin now 4%",
      }),
      one(pending.id),
    );
    expect(approved.status, await approved.clone().text()).toBe(200);
    const own = await (await routes.mine(call("sub"), undefined)).json();
    const row = own.submissions.find(
      (s: { id: string }) => s.id === pending.id,
    );
    expect(row.decisionNote).toBeNull();
    expect(JSON.stringify(own)).not.toContain("margin");
  });

  it("the database refuses edits after a decision and late lines (SQLSTATE 55000)", async () => {
    const pending = (await (
      await routes.submit(call("sub", await body()), undefined)
    ).json()) as { id: string };
    await routes.reject(call("owner", { note: "Synthetic" }), one(pending.id));
    const code = async (run: Promise<unknown>) =>
      run.then(
        () => "ok",
        (error: unknown) =>
          JSON.stringify(error).match(/55000/)?.[0] ?? String(error),
      );
    expect(
      await code(
        db.subcontractorBillSubmission.update({
          where: { id: pending.id },
          data: { decisionNote: "Changed later" },
        }),
      ),
    ).toBe("55000");
    expect(
      await code(
        db.subcontractorBillSubmissionItem.create({
          data: {
            companyId,
            submissionId: pending.id,
            position: 99,
            description: "Late line",
            taxCode: "TAXABLE_10",
            exclusiveCents: 1n,
            gstCents: 0n,
          },
        }),
      ),
    ).toBe("55000");
  });
  it("lists only the offer asked for, and caps pending invoices per contractor", async () => {
    const other = await routes.mine(
      (() => {
        const request = call("sub");
        return new Request(`${ORIGIN}/api/x?offerId=${randomUUID()}`, {
          headers: request.headers,
        });
      })(),
      undefined,
    );
    expect((await other.json()).submissions).toEqual([]);
    const waiting = await db.subcontractorBillSubmission.count({
      where: { companyId, contractorId, status: "submitted" },
    });
    for (let i = waiting; i < MAX_PENDING; i += 1)
      expect(
        (await routes.submit(call("sub", await body()), undefined)).status,
      ).toBe(201);
    const over = await routes.submit(call("sub", await body()), undefined);
    expect(over.status).toBe(409);
  });
});
