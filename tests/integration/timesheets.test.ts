import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  rateHandlers,
  timesheetHandlers,
} from "../../apps/web/src/server/timesheets/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #38: effective-dated cost rates; timesheets per job/visit by assigned
// employees; approval snapshots the rate and cost once; a later rate change
// never alters past cost; labour is never counted twice.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
type Who = (typeof ROLES)[number] | "visitOnly" | "inactive" | "outsider";
const PEOPLE = [...ROLES, "visitOnly", "inactive", "outsider"] as const;

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof timesheetHandlers>;
let rates: ReturnType<typeof rateHandlers>;
let companyId = "";
let customerId = "";
let jobId = "";
let otherJobId = "";
let outsiderJobId = "";
let visitA = "";
let visitB = "";
let cancelledVisit = "";
const employeeIds = {} as Record<Who, string>;
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x3838);

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
  handlers = timesheetHandlers(() => db);
  rates = rateHandlers(() => db);
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
  for (const [key, role] of [
    ...ROLES.slice(1).map((role) => [role, role] as const),
    ["visitOnly", "employee"] as const,
    ["inactive", "employee"] as const,
  ]) {
    await db.membership.create({
      data: { companyId, userId: userIds[key], createdBy: userIds.owner, role },
    });
  }
  customerId = (
    await db.customer.create({
      data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
    })
  ).id;
  const job = (number: number) =>
    db.job.create({
      data: {
        companyId,
        customerId,
        number,
        reference: `SJ-${number}`,
        title: `Sample job ${number}`,
        agreedPriceExclusiveCents: 250000n,
        createdBy: userIds.owner,
      },
    });
  jobId = (await job(1)).id;
  otherJobId = (await job(2)).id;
  const visit = (status: "scheduled" | "cancelled" = "scheduled") =>
    db.jobVisit.create({
      data: {
        companyId,
        jobId,
        startsAt: new Date("2026-07-02T08:00:00Z"),
        status,
        createdBy: userIds.owner,
      },
    });
  visitA = (await visit()).id;
  visitB = (await visit()).id;
  cancelledVisit = (await visit("cancelled")).id;
  const theirCustomer = await db.customer.create({
    data: {
      companyId: other.id,
      createdBy: userIds.outsider,
      name: "Other Co",
    },
  });
  outsiderJobId = (
    await db.job.create({
      data: {
        companyId: other.id,
        customerId: theirCustomer.id,
        number: 1,
        reference: "OC-1",
        title: "Theirs",
        createdBy: userIds.outsider,
      },
    })
  ).id;
  for (const key of ["owner", "employee", "visitOnly", "inactive"] as const) {
    employeeIds[key] = (
      await db.employee.create({
        data: {
          companyId,
          name: `Synthetic ${key}`,
          userId: userIds[key],
          createdBy: userIds.owner,
        },
      })
    ).id;
  }
  const assign = (key: Who, visitId: string | null = null) =>
    db.assignment.create({
      data: {
        companyId,
        jobId,
        employeeId: employeeIds[key],
        visitId,
        createdBy: userIds.owner,
      },
    });
  await assign("employee");
  await assign("visitOnly", visitA);
  await assign("inactive");
  await db.employee.update({
    where: { id: employeeIds.inactive },
    data: { isActive: false },
  });
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

function call(who: Who, method: string, body?: unknown): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/timesheets`, init);
}
type One = { params: Promise<{ id: string }> };
const one = (id: string): One => ({ params: Promise.resolve({ id }) });
const r = () => ({
  list: withPolicy("timesheet.approve", handlers.list),
  mine: withPolicy("timesheet.submit_own", handlers.mine),
  create: withPolicy("timesheet.submit_own", handlers.create),
  update: withPolicy<One>("timesheet.submit_own", handlers.update),
  decide: withPolicy<One>("timesheet.approve", handlers.decide),
  reverse: withPolicy<One>("timesheet.approve", handlers.reverse),
  rates: withPolicy<One>("employee.cost_rate.read", rates.list),
  addRate: withPolicy<One>("employee.write", rates.add),
});

async function submit(
  body: Record<string, unknown> = {},
  who: Who = "employee",
) {
  const response = await r().create(
    call(who, "POST", { jobId, workDate: "2026-07-02", minutes: 360, ...body }),
    undefined,
  );
  return { response, body: await response.json() };
}

const decide = (id: string, decision: "approve" | "reject" = "approve") =>
  r().decide(call("manager", "POST", { decision }), one(id));

const addRate = (key: Who, effectiveFrom: string, hourlyCostCents: string) =>
  r().addRate(
    call("manager", "POST", { effectiveFrom, hourlyCostCents }),
    one(employeeIds[key]),
  );

describe("rates", () => {
  it("adds effective-dated rates (append-only, one per start date), audited", async () => {
    expect((await addRate("employee", "2026-01-01", "4000")).status).toBe(201);
    expect((await addRate("employee", "2026-07-01", "5000")).status).toBe(201);
    expect((await addRate("employee", "2026-07-01", "5500")).status).toBe(409);
    expect((await addRate("employee", "2026-08-01", "-1")).status).toBe(400);
    const listed = await (
      await r().rates(call("owner", "GET"), one(employeeIds.employee))
    ).json();
    expect(
      listed.rates.map(
        (rate: { hourlyCostCents: string }) => rate.hourlyCostCents,
      ),
    ).toEqual(["5000", "4000"]);
    const rate = await db.employeeRate.findFirstOrThrow({
      where: { employeeId: employeeIds.employee },
    });
    await expect(
      db.employeeRate.update({
        where: { id: rate.id },
        data: { hourlyCostCents: 1n },
      }),
    ).rejects.toThrow(/append-only/);
    expect(
      await db.auditEvent.count({
        where: {
          targetId: employeeIds.employee,
          action: "employee.rate_added",
        },
      }),
    ).toBe(2);
  });

  it("hides rates from accountants and workers", async () => {
    for (const who of ["accountant", "employee", "subcontractor"] as const)
      expect(
        (await r().rates(call(who, "GET"), one(employeeIds.employee))).status,
        who,
      ).toBe(403);
  });
});

describe("submitting", () => {
  it("logs time on an assigned job, audited; the submitter sees no rate or cost", async () => {
    const { response, body } = await submit({ note: "Rough-in" });
    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      jobId,
      minutes: 360,
      workDate: "2026-07-02",
      status: "submitted",
    });
    expect(body).not.toHaveProperty("costCents");
    const mine = await (
      await r().mine(call("employee", "GET"), undefined)
    ).json();
    for (const item of mine.timesheets) {
      expect(item).not.toHaveProperty("costCents");
      expect(item).not.toHaveProperty("hourlyCostCents");
    }
    expect(
      await db.auditEvent.count({
        where: { targetId: body.id, action: "timesheet.submitted" },
      }),
    ).toBe(1);
  });

  it("allows only jobs and visits the employee is live-assigned to", async () => {
    expect((await submit({ jobId: otherJobId })).response.status).toBe(400);
    expect((await submit({ jobId: outsiderJobId })).response.status).toBe(400);
    expect((await submit({}, "inactive")).response.status).toBe(400);
    // Visit-only assignee: must name their own visit.
    expect((await submit({}, "visitOnly")).response.status).toBe(400);
    expect(
      (await submit({ visitId: visitB }, "visitOnly")).response.status,
    ).toBe(400);
    expect(
      (await submit({ visitId: visitA }, "visitOnly")).response.status,
    ).toBe(201);
    // Whole-job assignee: any live visit of the job.
    expect((await submit({ visitId: visitB })).response.status).toBe(201);
    expect((await submit({ visitId: cancelledVisit })).response.status).toBe(
      400,
    );
  });

  it("validates every write", async () => {
    for (const bad of [
      { minutes: 0 },
      { minutes: 1441 },
      { minutes: 1.5 },
      { minutes: "60" },
      { workDate: "2999-01-01" },
      { workDate: "2026-02-30" },
      { jobId: "not-a-uuid" },
    ])
      expect((await submit(bad)).response.status, JSON.stringify(bad)).toBe(
        400,
      );
  });

  it("refuses office roles without submit_own and workers reading or deciding", async () => {
    for (const who of ["manager", "accountant", "subcontractor"] as const)
      expect((await submit({}, who)).response.status, who).toBe(403);
    for (const who of ["accountant", "employee"] as const)
      expect((await r().list(call(who, "GET"), undefined)).status, who).toBe(
        403,
      );
    const { body } = await submit();
    expect(
      (
        await r().decide(
          call("employee", "POST", { decision: "approve" }),
          one(body.id),
        )
      ).status,
    ).toBe(403);
  });

  it("only the submitter edits a submitted timesheet, audited", async () => {
    const { body } = await submit();
    expect(
      (await r().update(call("owner", "PATCH", { minutes: 1 }), one(body.id)))
        .status,
    ).toBe(404);
    const edited = await r().update(
      call("employee", "PATCH", { minutes: 300 }),
      one(body.id),
    );
    expect(await edited.json()).toMatchObject({ minutes: 300 });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { targetId: body.id, action: "timesheet.updated" },
    });
    expect(audit.metadata).toMatchObject({
      changes: { minutes: { before: 360, after: 300 } },
    });
  });
});

describe("approval: labour cost at the snapshotted rate", () => {
  it("costs 6 h at the rate in effect on the work date (the fixture's 30000)", async () => {
    const { body } = await submit();
    const approved = await (await decide(body.id)).json();
    expect(approved).toMatchObject({
      status: "approved",
      hourlyCostCents: "5000",
      costCents: "30000",
    });
  });

  it("a rate change does not alter past costs", async () => {
    const { body } = await submit({ workDate: "2026-07-05" });
    await decide(body.id);
    // A later rate, even one starting before that work date.
    expect((await addRate("employee", "2026-07-03", "9000")).status).toBe(201);
    const row = await db.timesheet.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(row).toMatchObject({ hourlyCostCents: 5000n, costCents: 30000n });
    const later = await submit({ workDate: "2026-07-05" });
    expect(await (await decide(later.body.id)).json()).toMatchObject({
      costCents: "54000",
    });
  });

  it("refuses to approve without a rate on the work date", async () => {
    const { body } = await submit({ workDate: "2025-12-31" });
    const response = await decide(body.id);
    expect(response.status).toBe(409);
    expect(
      (await db.timesheet.findUniqueOrThrow({ where: { id: body.id } })).status,
    ).toBe("submitted");
  });

  it("unapproved and rejected timesheets carry no cost", async () => {
    const { body } = await submit();
    const rejected = await (await decide(body.id, "reject")).json();
    expect(rejected).toMatchObject({ status: "rejected", costCents: null });
  });
});

describe("labour is never counted twice", () => {
  it("decides once, even concurrently", async () => {
    const { body } = await submit();
    const results = await Promise.all([
      decide(body.id),
      decide(body.id),
      decide(body.id, "reject"),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409, 409]);
    expect(
      await db.auditEvent.count({
        where: {
          targetId: body.id,
          action: { in: ["timesheet.approved", "timesheet.rejected"] },
        },
      }),
    ).toBe(1);
  });

  it("is final once approved; a reversal nets it to zero, once", async () => {
    const { body } = await submit();
    await decide(body.id);
    expect(
      (
        await r().update(
          call("employee", "PATCH", { minutes: 1 }),
          one(body.id),
        )
      ).status,
    ).toBe(409);
    await expect(
      db.timesheet.update({ where: { id: body.id }, data: { minutes: 1 } }),
    ).rejects.toThrow(/record a reversal/);
    await expect(
      db.timesheet.delete({ where: { id: body.id } }),
    ).rejects.toThrow(/never deleted/);
    const reversed = await r().reverse(
      call("manager", "POST", { note: "Wrong job" }),
      one(body.id),
    );
    expect(reversed.status).toBe(201);
    expect(await reversed.json()).toMatchObject({
      minutes: -360,
      costCents: "-30000",
      hourlyCostCents: "5000",
      reversesId: body.id,
    });
    expect(
      (
        await r().reverse(
          call("manager", "POST", { note: "Again" }),
          one(body.id),
        )
      ).status,
    ).toBe(409);
    const rows = await db.timesheet.findMany({
      where: { OR: [{ id: body.id }, { reversesId: body.id }] },
    });
    expect(rows.reduce((total, row) => total + (row.costCents ?? 0n), 0n)).toBe(
      0n,
    );
  });

  it("job labour = sum of approved snapshots: one row per approval", async () => {
    const job = await db.job.create({
      data: {
        companyId,
        customerId,
        number: 50,
        reference: "SJ-50",
        title: "Sum job",
        createdBy: userIds.owner,
      },
    });
    await db.assignment.create({
      data: {
        companyId,
        jobId: job.id,
        employeeId: employeeIds.employee,
        createdBy: userIds.owner,
      },
    });
    const a = await submit({ jobId: job.id, minutes: 120 });
    const b = await submit({ jobId: job.id, minutes: 240 });
    await submit({ jobId: job.id, minutes: 60 }); // pending
    await decide(a.body.id);
    await decide(b.body.id);
    await decide(a.body.id); // second approval: refused
    const approved = await db.timesheet.findMany({
      where: { jobId: job.id, status: "approved" },
    });
    expect(
      approved.reduce((total, row) => total + (row.costCents ?? 0n), 0n),
    ).toBe(30000n);
  });
});

describe("isolation and visibility", () => {
  it("isolates tenants", async () => {
    const { body } = await submit();
    expect(
      (
        await r().decide(
          call("outsider", "POST", { decision: "approve" }),
          one(body.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (await r().rates(call("outsider", "GET"), one(employeeIds.employee)))
        .status,
    ).toBe(404);
    const theirs = await r().list(call("outsider", "GET"), undefined);
    expect((await theirs.json()).total).toBe(0);
  });
});

describe("eligibility is rechecked under the shared locks", () => {
  it("writes nothing when the assignment ends while the submission waits", async () => {
    const job = await db.job.create({
      data: {
        companyId,
        customerId,
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
        employeeId: employeeIds.employee,
        createdBy: userIds.owner,
      },
    });
    let pending: Promise<Response> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
      await tx.assignment.update({
        where: { id: assignment.id },
        data: { endedAt: new Date(), endedBy: userIds.owner },
      });
      pending = r().create(
        call("employee", "POST", {
          jobId: job.id,
          workDate: "2026-07-02",
          minutes: 60,
        }),
        undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const response = await pending!;
    expect(response.status).toBe(400);
    expect(await db.timesheet.count({ where: { jobId: job.id } })).toBe(0);
  });
});
