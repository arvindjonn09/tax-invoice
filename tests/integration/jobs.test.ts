import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { jobHandlers } from "../../apps/web/src/server/jobs/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #31: per-company job numbers safe under concurrency, status machine with
// immutable history, multiple visits, GST-exclusive cents price.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
type Who = (typeof ROLES)[number] | "outsider";

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof jobHandlers>;
let companyId = "";
let otherCompanyId = "";
let customerId = "";
let otherCustomerId = "";
let archivedCustomerId = "";
let siteId = "";
let otherCustomersSiteId = "";
let outsiderJobId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x3131);

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
  handlers = jobHandlers(() => db);
  for (const key of [...ROLES, "outsider"] as const) {
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
      await tx.company.create({ data: { ...record, jobPrefix: "SJ-" } });
      await tx.membership.create({
        data: factory.membership(record.id, owner),
      });
    });
  }
  companyId = own.id;
  otherCompanyId = other.id;
  for (const role of ROLES.slice(1)) {
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[role],
        createdBy: userIds.owner,
        role,
      },
    });
  }
  const customer = (name: string, company = companyId, by = userIds.owner) =>
    db.customer.create({ data: { companyId: company, createdBy: by, name } });
  const site = (customer: string) =>
    db.location.create({
      data: {
        companyId,
        customerId: customer,
        createdBy: userIds.owner,
        addressLine1: "1 Sample Street",
        suburb: "Sampleton",
        state: "NSW",
        postcode: "2000",
      },
    });
  customerId = (await customer("Acme Sample")).id;
  const second = (await customer("Bravo Sample")).id;
  archivedCustomerId = (await customer("Old Sample")).id;
  await db.customer.update({
    where: { id: archivedCustomerId },
    data: { archivedAt: new Date() },
  });
  siteId = (await site(customerId)).id;
  otherCustomersSiteId = (await site(second)).id;
  otherCustomerId = (
    await customer("Other Co Client", otherCompanyId, userIds.outsider)
  ).id;
  let ip = 0;
  for (const key of [...ROLES, "outsider"] as const) {
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
  return new Request(`${ORIGIN}/api/jobs${query}`, init);
}
const one = (id: string) => ({ params: Promise.resolve({ id }) });
type One = { params: Promise<{ id: string }> };
type Visit = { params: Promise<{ id: string; visitId: string }> };
const r = () => ({
  list: withPolicy("job.read_all", handlers.list),
  create: withPolicy("job.write", handlers.create),
  read: withPolicy<One>("job.read_all", handlers.read),
  update: withPolicy<One>("job.write", handlers.update),
  status: withPolicy<One>("job.write", handlers.changeStatus),
  addVisit: withPolicy<One>("job.write", handlers.addVisit),
  updateVisit: withPolicy<Visit>("job.write", handlers.updateVisit),
});

async function newJob(body: Record<string, unknown> = {}, who: Who = "owner") {
  const response = await r().create(
    call(who, "POST", { customerId, title: "Sample job", ...body }),
    undefined,
  );
  return { response, body: await response.json() };
}

const move = (id: string, to: string, who: Who = "manager") =>
  r().status(call(who, "POST", { to }), one(id));

describe("job numbering", () => {
  it("numbers sequentially per company with the prefix snapshot", async () => {
    const first = await newJob({ agreedPriceExclusiveCents: "250000" });
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({
      number: 1,
      reference: "SJ-0001",
      status: "draft",
      agreedPriceExclusiveCents: "250000",
    });
    // Another company starts its own sequence.
    const theirs = await r().create(
      call("outsider", "POST", {
        customerId: otherCustomerId,
        title: "Theirs",
      }),
      undefined,
    );
    const theirsBody = await theirs.json();
    outsiderJobId = theirsBody.id;
    expect(theirsBody.number).toBe(1);
  });

  it("never duplicates a number under parallel creation", async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => newJob({ title: `Parallel ${i}` })),
    );
    expect(created.every(({ response }) => response.status === 201)).toBe(true);
    const numbers = created
      .map(({ body }) => body.number)
      .sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(20);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    expect(await db.job.count({ where: { companyId } })).toBe(21);
  });
});

describe("job validation and sites", () => {
  it("requires an active customer of this company and a site of that customer", async () => {
    for (const [body, field] of [
      [{ customerId: archivedCustomerId }, "customerId"],
      [{ customerId: otherCustomerId }, "customerId"],
      [{ locationId: otherCustomersSiteId }, "locationId"],
    ] as const) {
      const { response, body: error } = await newJob(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(error.fields ?? {})).toEqual([field]);
    }
    expect((await newJob({ locationId: siteId })).response.status).toBe(201);
    // The database refuses a site of another customer outright.
    await expect(
      db.job.create({
        data: {
          companyId,
          createdBy: userIds.owner,
          customerId,
          locationId: otherCustomersSiteId,
          number: 999,
          reference: "X",
          title: "Direct",
        },
      }),
    ).rejects.toThrow();
  });

  it("validates title, cents and dates", async () => {
    for (const body of [
      { title: " " },
      { agreedPriceExclusiveCents: 12.5 },
      { agreedPriceExclusiveCents: "-1" },
      { agreedPriceExclusiveCents: "12.50" },
      { dueOn: "2026-02-30" },
      { customerId: "nope" },
    ]) {
      expect((await newJob(body)).response.status, JSON.stringify(body)).toBe(
        400,
      );
    }
  });
});

describe("status machine", () => {
  let jobId = "";

  it("walks allowed moves, recording an immutable timeline and audit", async () => {
    jobId = (await newJob()).body.id;
    for (const to of [
      "quoted",
      "approved",
      "assigned",
      "in_progress",
      "awaiting_review",
      "in_progress",
      "awaiting_review",
      "completed",
      "closed",
    ]) {
      const response = await move(jobId, to);
      expect(response.status, to).toBe(200);
      expect((await response.json()).status).toBe(to);
    }
    const detail = await (
      await r().read(call("owner", "GET"), one(jobId))
    ).json();
    expect(
      detail.statusHistory.map(
        (e: { fromStatus: string | null; toStatus: string }) =>
          `${e.fromStatus ?? "∅"}→${e.toStatus}`,
      ),
    ).toEqual([
      "∅→draft",
      "draft→quoted",
      "quoted→approved",
      "approved→assigned",
      "assigned→in_progress",
      "in_progress→awaiting_review",
      "awaiting_review→in_progress",
      "in_progress→awaiting_review",
      "awaiting_review→completed",
      "completed→closed",
    ]);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "job.status_changed", targetId: jobId },
      }),
    ).toBe(9);
  });

  it("rejects illegal transitions, system-only 'invoiced' and moves out of final states", async () => {
    const fresh = (await newJob()).body.id;
    for (const to of ["completed", "in_progress", "closed", "draft", "nope"]) {
      expect((await move(fresh, to)).status, to).toBe(
        to === "nope" ? 400 : 409,
      );
    }
    for (const to of [
      "approved",
      "in_progress",
      "awaiting_review",
      "completed",
    ])
      await move(fresh, to === "in_progress" ? "in_progress" : to);
    expect((await move(fresh, "invoiced")).status).toBe(409);
    expect((await move(jobId, "in_progress")).status).toBe(409);
    expect((await move(jobId, "cancelled")).status).toBe(409);
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: fresh } })).status,
    ).toBe("completed");
  });

  it("applies only one of two concurrent moves from the same status", async () => {
    const id = (await newJob()).body.id;
    const [a, b] = await Promise.all([
      move(id, "quoted"),
      move(id, "approved"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.jobStatusEvent.count({ where: { jobId: id } })).toBe(2);
  });

  it("keeps status history uneditable, even for direct database writes", async () => {
    await expect(
      db.jobStatusEvent.updateMany({
        where: { jobId },
        data: { note: "rewritten" },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.jobStatusEvent.deleteMany({ where: { jobId } }),
    ).rejects.toThrow(/append-only/);
    expect(await db.jobStatusEvent.count({ where: { jobId } })).toBe(10);
  });

  it("cancelled jobs stay (with their history) and can't be edited", async () => {
    const id = (await newJob({ agreedPriceExclusiveCents: 1000 })).body.id;
    expect((await move(id, "cancelled")).status).toBe(200);
    expect(
      (await r().update(call("owner", "PATCH", { title: "Edit" }), one(id)))
        .status,
    ).toBe(409);
    expect(
      (
        await r().addVisit(
          call("owner", "POST", { startsAt: "2026-11-01T09:00:00+11:00" }),
          one(id),
        )
      ).status,
    ).toBe(409);
    const cancelled = await (
      await r().list(
        call("owner", "GET", undefined, "?status=cancelled"),
        undefined,
      )
    ).json();
    expect(cancelled.jobs.map((j: { id: string }) => j.id)).toContain(id);
  });
});

describe("visits", () => {
  it("schedules several visits per job and reschedules/completes them", async () => {
    const id = (await newJob()).body.id;
    const first = await r().addVisit(
      call("manager", "POST", {
        startsAt: "2026-11-02T08:00:00+11:00",
        endsAt: "2026-11-02T12:00:00+11:00",
      }),
      one(id),
    );
    expect(first.status).toBe(201);
    const second = await r().addVisit(
      call("manager", "POST", { startsAt: "2026-11-03T08:00:00+11:00" }),
      one(id),
    );
    const visitId = (await second.json()).id;
    expect(
      (
        await r().addVisit(
          call("manager", "POST", {
            startsAt: "2026-11-02T12:00:00+11:00",
            endsAt: "2026-11-02T08:00:00+11:00",
          }),
          one(id),
        )
      ).status,
    ).toBe(400);
    const done = await r().updateVisit(
      call("manager", "PATCH", { status: "completed" }),
      { params: Promise.resolve({ id, visitId }) },
    );
    expect((await done.json()).status).toBe("completed");
    const detail = await (await r().read(call("owner", "GET"), one(id))).json();
    expect(detail.visits).toHaveLength(2);
  });
});

describe("access", () => {
  it("lets office roles read and only owner/manager write; employees/subcontractors 403", async () => {
    for (const role of ["owner", "manager", "accountant"] as const)
      expect((await r().list(call(role, "GET"), undefined)).status, role).toBe(
        200,
      );
    for (const role of ["employee", "subcontractor"] as const)
      expect((await r().list(call(role, "GET"), undefined)).status, role).toBe(
        403,
      );
    for (const role of ["accountant", "employee", "subcontractor"] as const)
      expect((await newJob({}, role)).response.status, role).toBe(403);
  });

  it("isolates tenants", async () => {
    const theirs = await (
      await r().list(call("outsider", "GET"), undefined)
    ).json();
    expect(theirs.jobs.map((j: { id: string }) => j.id)).toEqual([
      outsiderJobId,
    ]);
    for (const id of [
      outsiderJobId,
      "00000000-0000-4000-8000-000000000000",
      "x",
    ]) {
      expect((await r().read(call("owner", "GET"), one(id))).status, id).toBe(
        404,
      );
      expect((await move(id, "quoted", "owner")).status, id).toBe(404);
      expect(
        (await r().update(call("owner", "PATCH", { title: "Hijack" }), one(id)))
          .status,
        id,
      ).toBe(404);
    }
    expect(
      (await db.job.findUniqueOrThrow({ where: { id: outsiderJobId } })).status,
    ).toBe("draft");
  });
});

describe("audit integrity", () => {
  it("audits concurrent edits as a real before→after chain and skips no-ops", async () => {
    const id = (await newJob({ title: "Chain 0" })).body.id;
    await Promise.all(
      ["Chain 1", "Chain 2", "Chain 3"].map((title) =>
        r().update(call("manager", "PATCH", { title }), one(id)),
      ),
    );
    const events = await db.auditEvent.findMany({
      where: { companyId, targetId: id, action: "job.updated" },
    });
    const changes = events.map(
      (event) =>
        (
          event.metadata as {
            changes: { title: { before: string; after: string } };
          }
        ).changes.title,
    );
    expect(changes).toHaveLength(3);
    const befores = changes.map((c) => c.before);
    expect(new Set(befores).size).toBe(3);
    for (const before of befores)
      expect(["Chain 0", ...changes.map((c) => c.after)]).toContain(before);

    const current = (await db.job.findUniqueOrThrow({ where: { id } })).title;
    expect(
      (await r().update(call("manager", "PATCH", { title: current }), one(id)))
        .status,
    ).toBe(200);
    expect(
      await db.auditEvent.count({
        where: { companyId, targetId: id, action: "job.updated" },
      }),
    ).toBe(3);
  });
});

describe("review fixes (#111)", () => {
  it("freezes visits of a final job: refused, visit and audit unchanged", async () => {
    const id = (await newJob()).body.id;
    const visit = await (
      await r().addVisit(
        call("manager", "POST", { startsAt: "2026-11-05T08:00:00+11:00" }),
        one(id),
      )
    ).json();
    expect((await move(id, "cancelled")).status).toBe(200);
    const audits = () =>
      db.auditEvent.count({
        where: { companyId, action: "job_visit.updated", targetId: visit.id },
      });
    const before = await audits();
    const response = await r().updateVisit(
      call("manager", "PATCH", { status: "completed", notes: "late edit" }),
      { params: Promise.resolve({ id, visitId: visit.id }) },
    );
    expect(response.status).toBe(409);
    const row = await db.jobVisit.findUniqueOrThrow({
      where: { id: visit.id },
    });
    expect(row.status).toBe("scheduled");
    expect(row.notes).toBeNull();
    expect(await audits()).toBe(before);
  });

  it("cancels completed work (costs kept); an invoiced job needs the system", async () => {
    const id = (await newJob()).body.id;
    for (const to of [
      "approved",
      "in_progress",
      "awaiting_review",
      "completed",
    ])
      expect((await move(id, to)).status, to).toBe(200);
    expect((await move(id, "cancelled")).status).toBe(200);

    const invoiced = (await newJob()).body.id;
    // Simulate M3 invoice issue (system move) directly.
    await db.job.update({
      where: { id: invoiced },
      data: { status: "invoiced" },
    });
    const refused = await move(invoiced, "cancelled");
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/invoice/i);
  });

  it("orders the timeline by insertion sequence", async () => {
    const id = (await newJob()).body.id;
    for (const to of ["quoted", "draft", "quoted", "approved"])
      await move(id, to);
    const events = await db.jobStatusEvent.findMany({
      where: { jobId: id },
      orderBy: { seq: "asc" },
    });
    const detail = await (await r().read(call("owner", "GET"), one(id))).json();
    expect(detail.statusHistory.map((e: { id: string }) => e.id)).toEqual(
      events.map((e) => e.id),
    );
    expect(events.map((e) => `${e.fromStatus ?? "∅"}→${e.toStatus}`)).toEqual([
      "∅→draft",
      "draft→quoted",
      "quoted→draft",
      "draft→quoted",
      "quoted→approved",
    ]);
  });
});
