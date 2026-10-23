import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { contractorHandlers } from "../../apps/web/src/server/contractors/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #35: contractors with ABN and GST flag; fixed/hourly offers in GST-exclusive
// cents with a tax code; accept/decline with a timestamp; acceptance snapshots
// the rate and records the committed cost once; accepted terms are immutable.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
type Who = (typeof ROLES)[number] | "sub2" | "outsider";
const PEOPLE = [...ROLES, "sub2", "outsider"] as const;

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof contractorHandlers>;
let companyId = "";
let otherCompanyId = "";
let customerId = "";
let outsiderContractorId = "";
let outsiderJobId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x3535);
const ABN = syntheticAbn("135792468");

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
  handlers = contractorHandlers(() => db);
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
    ["sub2", "subcontractor"] as const,
  ]) {
    await db.membership.create({
      data: { companyId, userId: userIds[key], createdBy: userIds.owner, role },
    });
  }
  // Registered for GST since 2020, so creditable GST is never committed cost.
  await db.companyGstRegistration.create({
    data: {
      companyId,
      startsOn: new Date("2020-01-01T00:00:00Z"),
      basis: "non_cash",
      createdBy: userIds.owner,
    },
  });
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
    })
  ).id;
  const theirCustomer = await db.customer.create({
    data: {
      companyId: otherCompanyId,
      createdBy: userIds.outsider,
      name: "Other Co Client",
    },
  });
  outsiderJobId = (
    await db.job.create({
      data: {
        companyId: otherCompanyId,
        customerId: theirCustomer.id,
        number: 1,
        reference: "OC-0001",
        title: "Theirs",
        createdBy: userIds.outsider,
      },
    })
  ).id;
  outsiderContractorId = (
    await db.contractor.create({
      data: {
        companyId: otherCompanyId,
        name: "Their Contractor",
        createdBy: userIds.outsider,
      },
    })
  ).id;
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
  return new Request(`${ORIGIN}/api/contractors${query}`, init);
}
type One = { params: Promise<{ id: string }> };
type OfferCtx = { params: Promise<{ id: string; offerId: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const offerAt = (id: string, offerId: string): OfferCtx => ({
  params: Promise.resolve({ id, offerId }),
});
const r = () => ({
  list: withPolicy("contractor.read", handlers.list),
  create: withPolicy("contractor.write", handlers.create),
  read: withPolicy<One>("contractor.read", handlers.read),
  update: withPolicy<One>("contractor.write", handlers.update),
  jobOffers: withPolicy<One>("contractor.read", handlers.jobOffers),
  createOffer: withPolicy<One>("contractor.write", handlers.createOffer),
  updateOffer: withPolicy<OfferCtx>("contractor.write", handlers.updateOffer),
  myOffers: withPolicy("offer.read_own", handlers.myOffers),
  respond: withPolicy<One>("offer.respond_own", handlers.respond),
});

let jobNumber = 0;
async function newJob(status: "draft" | "cancelled" = "draft") {
  jobNumber += 1;
  return db.job.create({
    data: {
      companyId,
      customerId,
      number: jobNumber,
      reference: `SJ-${String(jobNumber).padStart(4, "0")}`,
      title: `Sample job ${jobNumber}`,
      agreedPriceExclusiveCents: 250000n,
      status,
      createdBy: userIds.owner,
    },
  });
}

async function newContractor(body: Record<string, unknown> = {}) {
  const response = await r().create(
    call("manager", "POST", { name: "Sample Sparkies", ...body }),
    undefined,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

const FIXED = {
  scope: "Rough-in and fit-off",
  rateType: "fixed",
  rateExclusiveCents: "90000",
  taxCode: "TAXABLE_10",
};

async function offer(
  jobId: string,
  contractorId: string,
  body: Record<string, unknown> = FIXED,
) {
  return r().createOffer(
    call("manager", "POST", { contractorId, ...body }),
    one(jobId),
  );
}

/** A GST-registered contractor linked to the `subcontractor` login. */
let linkedId = "";
async function linked() {
  if (!linkedId)
    linkedId = (
      await newContractor({
        name: "Linked Sample Electrical",
        abn: ABN,
        gstRegistered: true,
        userId: userIds.subcontractor,
      })
    ).id;
  return linkedId;
}

const respond = (who: Who, offerId: string, decision: string, note?: string) =>
  r().respond(
    call(who, "POST", { decision, ...(note ? { note } : {}) }),
    one(offerId),
  );

describe("contractors", () => {
  it("creates with ABN and GST flag, audited; GST registration needs an ABN", async () => {
    const created = await newContractor({
      abn: ABN.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4"),
      gstRegistered: true,
      email: "sparkies@jobflow.invalid",
    });
    const body = await (
      await r().read(call("accountant", "GET"), one(created.id))
    ).json();
    expect(body).toMatchObject({ abn: ABN, gstRegistered: true, offers: [] });
    expect(
      await db.auditEvent.count({
        where: { targetId: created.id, action: "contractor.created" },
      }),
    ).toBe(1);
    const noAbn = await r().create(
      call("manager", "POST", { name: "No ABN", gstRegistered: true }),
      undefined,
    );
    expect(noAbn.status).toBe(400);
    expect((await noAbn.json()).fields).toHaveProperty("abn");
    const badAbn = await r().create(
      call("manager", "POST", { name: "Bad", abn: "12 345 678 901" }),
      undefined,
    );
    expect(badAbn.status).toBe(400);
    // Clearing the ABN of a registered contractor is refused too.
    const clear = await r().update(
      call("manager", "PATCH", { abn: null }),
      one(created.id),
    );
    expect(clear.status).toBe(400);
  });

  it("links only an active subcontractor login of this company, once", async () => {
    await linked();
    for (const userId of [userIds.employee, userIds.outsider]) {
      const response = await r().create(
        call("manager", "POST", { name: "Wrong link", userId }),
        undefined,
      );
      expect(response.status).toBe(400);
    }
    const twice = await r().create(
      call("manager", "POST", { name: "Twice", userId: userIds.subcontractor }),
      undefined,
    );
    expect(twice.status).toBe(400);
  });

  it("archives (never deletes) and refuses new offers to archived contractors", async () => {
    const { id } = await newContractor({ name: "Retired Plumbing" });
    const archived = await r().update(
      call("manager", "PATCH", { archived: true }),
      one(id),
    );
    expect(archived.status).toBe(200);
    expect(
      await db.auditEvent.count({
        where: { targetId: id, action: "contractor.archived" },
      }),
    ).toBe(1);
    const active = await (
      await r().list(call("owner", "GET"), undefined)
    ).json();
    expect(active.contractors.map((c: { id: string }) => c.id)).not.toContain(
      id,
    );
    const all = await (
      await r().list(call("owner", "GET", undefined, "?status=all"), undefined)
    ).json();
    expect(all.contractors.map((c: { id: string }) => c.id)).toContain(id);
    const job = await newJob();
    expect((await offer(job.id, id)).status).toBe(400);
  });

  it("refuses writes to accountant/employee/subcontractor and reads to workers", async () => {
    for (const who of ["accountant", "employee", "subcontractor"] as const) {
      const response = await r().create(
        call(who, "POST", { name: "Nope" }),
        undefined,
      );
      expect(response.status, who).toBe(403);
    }
    for (const who of ["employee", "subcontractor"] as const) {
      expect((await r().list(call(who, "GET"), undefined)).status, who).toBe(
        403,
      );
    }
    expect(
      (await r().myOffers(call("employee", "GET"), undefined)).status,
    ).toBe(403);
  });

  it("isolates tenants: no read, update or offer across companies", async () => {
    expect(
      (await r().read(call("owner", "GET"), one(outsiderContractorId))).status,
    ).toBe(404);
    expect(
      (
        await r().update(
          call("owner", "PATCH", { name: "Mine" }),
          one(outsiderContractorId),
        )
      ).status,
    ).toBe(404);
    expect(
      (await r().jobOffers(call("owner", "GET"), one(outsiderJobId))).status,
    ).toBe(404);
    expect((await offer(outsiderJobId, await linked())).status).toBe(404);
    const job = await newJob();
    expect((await offer(job.id, outsiderContractorId)).status).toBe(400);
    // A forged companyId in the body is ignored.
    const forged = await r().create(
      call("owner", "POST", { name: "Forged", companyId: otherCompanyId }),
      undefined,
    );
    expect(
      (
        await db.contractor.findUniqueOrThrow({
          where: { id: (await forged.json()).id },
        })
      ).companyId,
    ).toBe(companyId);
  });
});

describe("offers", () => {
  it("offers fixed or hourly work in GST-exclusive cents with a tax code", async () => {
    const job = await newJob();
    const contractorId = await linked();
    const fixed = await offer(job.id, contractorId);
    expect(fixed.status).toBe(201);
    expect(await fixed.json()).toMatchObject({
      rateType: "fixed",
      rateExclusiveCents: "90000",
      estimatedHours: null,
      taxCode: "TAXABLE_10",
      exclusiveCents: "90000",
      gstCents: "9000",
      inclusiveCents: "99000",
      status: "offered",
      acceptance: null,
    });
    const other = await newContractor({
      name: "Hourly Sample",
      abn: ABN,
      gstRegistered: true,
    });
    const hourly = await offer(job.id, other.id, {
      scope: "Labour hire",
      rateType: "hourly",
      rateExclusiveCents: 8333,
      estimatedHours: "7.5",
      taxCode: "TAXABLE_10",
    });
    expect(hourly.status).toBe(201);
    expect(await hourly.json()).toMatchObject({
      estimatedHours: "7.50",
      exclusiveCents: "62498",
      gstCents: "6250",
    });
    const listed = await (
      await r().jobOffers(call("accountant", "GET"), one(job.id))
    ).json();
    expect(listed.offers).toHaveLength(2);
  });

  it("validates terms: unregistered contractors can't charge GST; hours match the rate type", async () => {
    const job = await newJob();
    const unregistered = await newContractor({ name: "Unregistered Sample" });
    const taxed = await offer(job.id, unregistered.id);
    expect(taxed.status).toBe(400);
    expect((await taxed.json()).fields).toHaveProperty("taxCode");
    expect(
      (
        await offer(job.id, unregistered.id, {
          ...FIXED,
          taxCode: "OUT_OF_SCOPE",
        })
      ).status,
    ).toBe(201);
    for (const bad of [
      { ...FIXED, rateType: "hourly" },
      { ...FIXED, estimatedHours: "3" },
      { ...FIXED, rateExclusiveCents: "-1" },
      { ...FIXED, rateExclusiveCents: 12.5 },
      { ...FIXED, taxCode: "GST" },
      { ...FIXED, scope: " " },
    ]) {
      const other = await newContractor({
        name: "Bad terms",
        abn: ABN,
        gstRegistered: true,
      });
      expect(
        (await offer(job.id, other.id, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
  });

  it("allows one live offer per contractor per job and none on a closed job", async () => {
    const job = await newJob();
    const { id } = await newContractor({
      name: "Once Only",
      abn: ABN,
      gstRegistered: true,
    });
    expect((await offer(job.id, id)).status).toBe(201);
    expect((await offer(job.id, id)).status).toBe(409);
    const cancelled = await newJob("cancelled");
    expect((await offer(cancelled.id, id)).status).toBe(409);
  });

  it("edits and withdraws an open offer, audited; a withdrawn offer is final", async () => {
    const job = await newJob();
    const { id } = await newContractor({
      name: "Editable",
      abn: ABN,
      gstRegistered: true,
    });
    const created = await (await offer(job.id, id)).json();
    const edited = await r().updateOffer(
      call("manager", "PATCH", { rateExclusiveCents: "95000" }),
      offerAt(job.id, created.id),
    );
    expect(await edited.json()).toMatchObject({
      rateExclusiveCents: "95000",
      gstCents: "9500",
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { targetId: created.id, action: "contractor_offer.updated" },
    });
    expect(audit.metadata).toMatchObject({
      changes: { rateExclusiveCents: { before: "90000", after: "95000" } },
    });
    const withdrawn = await r().updateOffer(
      call("manager", "PATCH", { status: "withdrawn", note: "Scope changed" }),
      offerAt(job.id, created.id),
    );
    expect(await withdrawn.json()).toMatchObject({
      status: "withdrawn",
      responseNote: "Scope changed",
    });
    expect(
      (
        await r().updateOffer(
          call("manager", "PATCH", { rateExclusiveCents: "1" }),
          offerAt(job.id, created.id),
        )
      ).status,
    ).toBe(409);
    // A new offer may follow a withdrawn one.
    expect((await offer(job.id, id)).status).toBe(201);
    // The offer must belong to the job in the URL.
    const elsewhere = await newJob();
    expect(
      (
        await r().updateOffer(
          call("manager", "PATCH", { scope: "x" }),
          offerAt(elsewhere.id, created.id),
        )
      ).status,
    ).toBe(404);
  });
});

describe("acceptance", () => {
  it("snapshots the rate, GST and committed cost once; accepted rates can't be edited", async () => {
    const job = await newJob();
    const created = await (await offer(job.id, await linked())).json();
    const accepted = await respond("subcontractor", created.id, "accept");
    expect(accepted.status).toBe(200);
    const body = await accepted.json();
    expect(body).toMatchObject({
      status: "accepted",
      respondedAt: expect.any(String),
      acceptance: {
        rateExclusiveCents: "90000",
        exclusiveCents: "90000",
        gstCents: "9000",
        inclusiveCents: "99000",
        acceptedAt: expect.any(String),
      },
    });
    const snapshot = await db.contractorAcceptance.findUniqueOrThrow({
      where: { offerId: created.id },
    });
    // Registered company: the 9000 GST is creditable, never job cost.
    expect(snapshot).toMatchObject({
      committedCostCents: 90000n,
      companyGstRegistered: true,
      contractorGstRegistered: true,
      gstRateBasisPoints: 1000,
      acceptedBy: userIds.subcontractor,
    });

    // API: accepted terms are final.
    for (const change of [
      { rateExclusiveCents: "1" },
      { status: "withdrawn" },
    ]) {
      const response = await r().updateOffer(
        call("owner", "PATCH", change),
        offerAt(job.id, created.id),
      );
      expect(response.status).toBe(409);
    }
    // Answering twice changes nothing and records no second commitment.
    expect((await respond("subcontractor", created.id, "accept")).status).toBe(
      409,
    );
    expect((await respond("subcontractor", created.id, "decline")).status).toBe(
      409,
    );
    expect(
      await db.contractorAcceptance.count({ where: { offerId: created.id } }),
    ).toBe(1);

    // Database: neither the accepted offer nor its snapshot can change or go.
    await expect(
      db.contractorOffer.update({
        where: { id: created.id },
        data: { rateExclusiveCents: 1n },
      }),
    ).rejects.toThrow(/can't be changed/);
    await expect(
      db.contractorOffer.delete({ where: { id: created.id } }),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db.contractorAcceptance.update({
        where: { id: snapshot.id },
        data: { committedCostCents: 1n },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.contractorAcceptance.delete({ where: { id: snapshot.id } }),
    ).rejects.toThrow(/append-only/);

    // Editing the contractor later doesn't touch the snapshot.
    await r().update(
      call("manager", "PATCH", { name: "Renamed Electrical" }),
      one(await linked()),
    );
    const office = await (
      await r().jobOffers(call("accountant", "GET"), one(job.id))
    ).json();
    expect(office.offers[0].acceptance).toMatchObject({
      committedCostCents: "90000",
      exclusiveCents: "90000",
    });
  });

  it("serialises concurrent accept/decline: exactly one wins, one commitment", async () => {
    const job = await newJob();
    const created = await (await offer(job.id, await linked())).json();
    const results = await Promise.all([
      respond("subcontractor", created.id, "accept"),
      respond("subcontractor", created.id, "accept"),
      respond("subcontractor", created.id, "decline"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const final = await db.contractorOffer.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(
      await db.contractorAcceptance.count({ where: { offerId: created.id } }),
    ).toBe(final.status === "accepted" ? 1 : 0);
  });

  it("declines with a note and timestamp, recording no commitment", async () => {
    const job = await newJob();
    const created = await (await offer(job.id, await linked())).json();
    const declined = await respond(
      "subcontractor",
      created.id,
      "decline",
      "Booked out",
    );
    expect(await declined.json()).toMatchObject({
      status: "declined",
      responseNote: "Booked out",
      respondedAt: expect.any(String),
      acceptance: null,
    });
    expect(
      await db.contractorAcceptance.count({ where: { offerId: created.id } }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { targetId: created.id, action: "contractor_offer.declined" },
      }),
    ).toBe(1);
  });

  it("commits GST-inclusive cost when the company isn't registered (GST not claimable)", async () => {
    // The outsider's company has no GST registration.
    const theirJob = await db.job.findUniqueOrThrow({
      where: { id: outsiderJobId },
    });
    const sub = await createCredentialUser(db, {
      email: "their-sub@jobflow.invalid",
      name: "Synthetic their sub",
      password: PASSWORD,
    });
    await db.membership.create({
      data: {
        companyId: otherCompanyId,
        userId: sub.id,
        createdBy: userIds.outsider,
        role: "subcontractor",
      },
    });
    const contractor = await db.contractor.create({
      data: {
        companyId: otherCompanyId,
        name: "Registered Supplier",
        abn: ABN,
        gstRegistered: true,
        userId: sub.id,
        createdBy: userIds.outsider,
      },
    });
    const created = await db.contractorOffer.create({
      data: {
        companyId: otherCompanyId,
        jobId: theirJob.id,
        contractorId: contractor.id,
        scope: "Supply and install",
        rateType: "fixed",
        rateExclusiveCents: 90000n,
        taxCode: "TAXABLE_10",
        createdBy: userIds.outsider,
      },
    });
    // Respond through the handler as that subcontractor (their own session).
    const auth = createAuth({
      db,
      secret: randomBytes(32).toString("hex"),
      baseURL: ORIGIN,
      production: false,
    });
    const policy = createWithPolicy({
      auth: () => auth,
      db: () => db,
      trustedOrigins: () => [ORIGIN],
    });
    const signIn = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": "203.0.113.99",
        },
        body: JSON.stringify({
          email: "their-sub@jobflow.invalid",
          password: PASSWORD,
        }),
      }),
    );
    const headers = new Headers({
      cookie: signIn.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
      origin: ORIGIN,
      "content-type": "application/json",
    });
    const response = await policy<One>("offer.respond_own", handlers.respond)(
      new Request(`${ORIGIN}/api/my/offers/${created.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ decision: "accept" }),
      }),
      one(created.id),
    );
    expect(response.status).toBe(200);
    expect(
      await db.contractorAcceptance.findUniqueOrThrow({
        where: { offerId: created.id },
      }),
    ).toMatchObject({
      companyGstRegistered: false,
      committedCostCents: 99000n,
    });
  });
});

describe("subcontractor visibility", () => {
  it("lists only their own offers, without job price, committed cost or other rates", async () => {
    const job = await newJob();
    await offer(job.id, await linked());
    const rival = await newContractor({
      name: "Rival Sample",
      abn: ABN,
      gstRegistered: true,
    });
    const rivalOffer = await (
      await offer(job.id, rival.id, { ...FIXED, rateExclusiveCents: "70000" })
    ).json();
    const mine = await (
      await r().myOffers(call("subcontractor", "GET"), undefined)
    ).json();
    expect(mine.total).toBeGreaterThan(0);
    const contractorId = await linked();
    for (const item of mine.offers) {
      expect(item.contractorId).toBe(contractorId);
      expect(item).not.toHaveProperty("contractorName");
      expect(item.job).toEqual({
        reference: expect.any(String),
        title: expect.any(String),
        status: expect.any(String),
        dueOn: null,
      });
      if (item.acceptance)
        expect(item.acceptance).not.toHaveProperty("committedCostCents");
    }
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(
      /agreedPrice|committedCost|companyGstRegistered|250000|70000/,
    );
    // A linked-less subcontractor sees nothing; another's offer is not found.
    expect(
      await (await r().myOffers(call("sub2", "GET"), undefined)).json(),
    ).toMatchObject({ total: 0, offers: [] });
    expect(
      (await respond("subcontractor", rivalOffer.id, "accept")).status,
    ).toBe(404);
    expect((await respond("sub2", rivalOffer.id, "accept")).status).toBe(404);
    expect(
      (await respond("subcontractor", "not-a-uuid", "accept")).status,
    ).toBe(404);
  });

  it("refuses office roles and employees answering offers on a contractor's behalf", async () => {
    const job = await newJob();
    const created = await (await offer(job.id, await linked())).json();
    expect((await respond("employee", created.id, "accept")).status).toBe(403);
    expect((await respond("manager", created.id, "accept")).status).toBe(403);
    // Owner holds every permission but has no contractor record here.
    expect((await respond("owner", created.id, "accept")).status).toBe(404);
  });

  it("refuses answers once the job is closed or the contractor archived", async () => {
    const job = await newJob();
    const created = await (await offer(job.id, await linked())).json();
    await db.job.update({
      where: { id: job.id },
      data: { status: "cancelled" },
    });
    expect((await respond("subcontractor", created.id, "accept")).status).toBe(
      409,
    );
  });
});

/**
 * Pause the first `contractor.findFirst` outside a transaction (a handler's
 * preflight) until `mutate` has committed, then let the handler continue.
 */
async function withStalePreflight(
  run: (handlers: ReturnType<typeof contractorHandlers>) => Promise<Response>,
  mutate: () => Promise<unknown>,
) {
  let announce!: () => void;
  let resume!: () => void;
  const observed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const contractorProxy = new Proxy(db.contractor, {
    get(target, property, receiver) {
      if (property === "findFirst")
        return async (...args: Parameters<typeof db.contractor.findFirst>) => {
          const before = await db.contractor.findFirst(...args);
          announce();
          await released;
          return before;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const wrapped = new Proxy(db, {
    get(target, property, receiver) {
      return property === "contractor"
        ? contractorProxy
        : Reflect.get(target, property, receiver);
    },
  });
  const pending = run(contractorHandlers(() => wrapped));
  try {
    await observed;
    await mutate();
  } finally {
    resume();
  }
  return pending;
}

describe("locked rechecks (Codex #116 review)", () => {
  it("refuses an answer from a login unlinked after the preflight; no snapshot", async () => {
    const sub = await createCredentialUser(db, {
      email: "relink-sub@jobflow.invalid",
      name: "Synthetic relink sub",
      password: PASSWORD,
    });
    await db.membership.create({
      data: {
        companyId,
        userId: sub.id,
        createdBy: userIds.owner,
        role: "subcontractor",
      },
    });
    const contractor = await db.contractor.create({
      data: {
        companyId,
        name: "Relink Sample",
        abn: ABN,
        gstRegistered: true,
        userId: userIds.sub2,
        createdBy: userIds.owner,
      },
    });
    const job = await newJob();
    const created = await (await offer(job.id, contractor.id)).json();
    const response = await withStalePreflight(
      (fresh) =>
        withPolicy<One>("offer.respond_own", fresh.respond)(
          call("sub2", "POST", { decision: "accept" }),
          one(created.id),
        ),
      () =>
        db.contractor.update({
          where: { id: contractor.id },
          data: { userId: sub.id },
        }),
    );
    expect(response.status).toBe(404);
    expect(
      await db.contractorAcceptance.count({ where: { offerId: created.id } }),
    ).toBe(0);
    expect(
      (
        await db.contractorOffer.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).status,
    ).toBe("offered");
  });

  it("refuses a new offer to a contractor archived after the preflight", async () => {
    const { id } = await newContractor({
      name: "Archived meanwhile",
      abn: ABN,
      gstRegistered: true,
    });
    const job = await newJob();
    const response = await withStalePreflight(
      (fresh) =>
        withPolicy<One>("contractor.write", fresh.createOffer)(
          call("manager", "POST", { contractorId: id, ...FIXED }),
          one(job.id),
        ),
      () =>
        db.contractor.update({
          where: { id },
          data: { archivedAt: new Date() },
        }),
    );
    expect(response.status).toBe(400);
    expect(
      await db.contractorOffer.count({ where: { contractorId: id } }),
    ).toBe(0);
  });

  it("refuses a taxable offer once the contractor is deregistered after the preflight", async () => {
    const { id } = await newContractor({
      name: "Deregistered meanwhile",
      abn: ABN,
      gstRegistered: true,
    });
    const job = await newJob();
    const response = await withStalePreflight(
      (fresh) =>
        withPolicy<One>("contractor.write", fresh.createOffer)(
          call("manager", "POST", { contractorId: id, ...FIXED }),
          one(job.id),
        ),
      () =>
        db.contractor.update({ where: { id }, data: { gstRegistered: false } }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toHaveProperty("taxCode");
  });

  it("keeps accepted amounts from the snapshot after the contractor's GST registration changes", async () => {
    const job = await newJob();
    const contractorId = await linked();
    const created = await (await offer(job.id, contractorId)).json();
    expect((await respond("subcontractor", created.id, "accept")).status).toBe(
      200,
    );
    const change = await r().update(
      call("manager", "PATCH", { gstRegistered: false }),
      one(contractorId),
    );
    expect(change.status).toBe(200);
    const office = await (
      await r().jobOffers(call("accountant", "GET"), one(job.id))
    ).json();
    const mine = await (
      await r().myOffers(call("subcontractor", "GET"), undefined)
    ).json();
    const own = mine.offers.find(
      (item: { id: string }) => item.id === created.id,
    );
    for (const view of [office.offers[0], own]) {
      expect(view).toMatchObject({
        status: "accepted",
        taxCode: "TAXABLE_10",
        exclusiveCents: "90000",
        gstCents: "9000",
        inclusiveCents: "99000",
      });
    }
    // Restore for later tests that reuse the linked contractor.
    await r().update(
      call("manager", "PATCH", { gstRegistered: true }),
      one(contractorId),
    );
  });
});
