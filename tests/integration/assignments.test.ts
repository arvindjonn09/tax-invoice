import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { assignmentHandlers } from "../../apps/web/src/server/jobs/assignments";
import { jobHandlers } from "../../apps/web/src/server/jobs/handlers";
import { myJobHandlers } from "../../apps/web/src/server/jobs/my-jobs";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #32: managers assign employees; employees see only their own work, by an
// allowlist that never carries price, cost or profit fields.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
type Who =
  | "owner"
  | "manager"
  | "accountant"
  | "worker"
  | "colleague"
  | "subcontractor"
  | "outsider";
const WHO: readonly Who[] = [
  "owner",
  "manager",
  "accountant",
  "worker",
  "colleague",
  "subcontractor",
  "outsider",
];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let jobs: ReturnType<typeof jobHandlers>;
let assignments: ReturnType<typeof assignmentHandlers>;
let mine: ReturnType<typeof myJobHandlers>;
let companyId = "";
let workerEmployee = "";
let colleagueEmployee = "";
let inactiveEmployee = "";
let outsiderEmployee = "";
let assignedJob = "";
let visitJob = "";
let visitId = "";
let unassignedJob = "";
let outsiderJob = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x3232);

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
  jobs = jobHandlers(() => db);
  assignments = assignmentHandlers(() => db);
  mine = myJobHandlers(() => db);
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
  for (const [key, role] of [
    ["manager", "manager"],
    ["accountant", "accountant"],
    ["worker", "employee"],
    ["colleague", "employee"],
    ["subcontractor", "subcontractor"],
  ] as const) {
    await db.membership.create({
      data: { companyId, userId: userIds[key], createdBy: userIds.owner, role },
    });
  }
  const employee = (name: string, userId: string | null, isActive = true) =>
    db.employee.create({
      data: { companyId, createdBy: userIds.owner, name, userId, isActive },
    });
  workerEmployee = (await employee("Wren Worker", userIds.worker)).id;
  colleagueEmployee = (await employee("Cal Colleague", userIds.colleague)).id;
  inactiveEmployee = (await employee("Ina Inactive", null, false)).id;
  outsiderEmployee = (
    await db.employee.create({
      data: {
        companyId: other.id,
        createdBy: userIds.outsider,
        name: "Other Co Worker",
      },
    })
  ).id;
  const customer = await db.customer.create({
    data: { companyId, createdBy: userIds.owner, name: "Acme Sample" },
  });
  const site = await db.location.create({
    data: {
      companyId,
      customerId: customer.id,
      createdBy: userIds.owner,
      label: "Depot",
      addressLine1: "1 Sample Street",
      suburb: "Sampleton",
      state: "NSW",
      postcode: "2000",
      accessNotes: "Gate code from office",
    },
  });
  const job = async (title: string, number: number) =>
    (
      await db.job.create({
        data: {
          companyId,
          createdBy: userIds.owner,
          customerId: customer.id,
          locationId: site.id,
          number,
          reference: `JOB-${number}`,
          title,
          status: "approved",
          agreedPriceExclusiveCents: 250000n,
        },
      })
    ).id;
  assignedJob = await job("Assigned job", 1);
  visitJob = await job("Visit job", 2);
  unassignedJob = await job("Someone else's job", 3);
  visitId = (
    await db.jobVisit.create({
      data: {
        companyId,
        jobId: visitJob,
        createdBy: userIds.owner,
        startsAt: new Date("2026-11-02T22:00:00Z"),
      },
    })
  ).id;
  const otherCustomer = await db.customer.create({
    data: { companyId: other.id, createdBy: userIds.outsider, name: "Theirs" },
  });
  outsiderJob = (
    await db.job.create({
      data: {
        companyId: other.id,
        createdBy: userIds.outsider,
        customerId: otherCustomer.id,
        number: 1,
        reference: "JOB-1",
        title: "Their job",
        status: "approved",
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
}, 90_000);
afterAll(() => database?.release());

function call(who: Who, method: string, body?: unknown, path = "/api/x") {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}${path}`, init);
}
const one = (id: string) => ({ params: Promise.resolve({ id }) });
type One = { params: Promise<{ id: string }> };
type Two = { params: Promise<{ id: string; assignmentId: string }> };
const r = () => ({
  assign: withPolicy<One>("job.assign", assignments.assign),
  end: withPolicy<Two>("job.assign", assignments.end),
  officeRead: withPolicy<One>("job.read_all", jobs.read),
  myList: withPolicy("job.read_assigned", mine.list),
  myRead: withPolicy<One>("job.read_assigned", mine.read),
});
const assign = (job: string, body: unknown, who: Who = "manager") =>
  r().assign(call(who, "POST", body), one(job));
const myIds = async (who: Who) =>
  (
    (await (await r().myList(call(who, "GET"), undefined)).json()).jobs as {
      id: string;
    }[]
  ).map((job) => job.id);

/** Every key at any depth of a JSON value. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [
      key,
      ...allKeys(item),
    ]);
  return [];
}

describe("assignments", () => {
  it("lets owner/manager assign active employees to a job or one of its visits, audited", async () => {
    const whole = await assign(assignedJob, { employeeId: workerEmployee });
    expect(whole.status).toBe(201);
    expect((await whole.json()).employeeName).toBe("Wren Worker");
    const visit = await assign(visitJob, {
      employeeId: workerEmployee,
      visitId,
    });
    expect(visit.status).toBe(201);
    expect(
      (await assign(unassignedJob, { employeeId: colleagueEmployee }, "owner"))
        .status,
    ).toBe(201);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "job.assigned" },
      }),
    ).toBe(3);
    const detail = await (
      await r().officeRead(call("manager", "GET"), one(assignedJob))
    ).json();
    expect(detail.assignments).toEqual([
      expect.objectContaining({
        employeeId: workerEmployee,
        employeeName: "Wren Worker",
        endedAt: null,
      }),
    ]);
  });

  it("refuses duplicates, inactive or foreign employees, and another job's visit", async () => {
    expect(
      (await assign(assignedJob, { employeeId: workerEmployee })).status,
    ).toBe(409);
    for (const body of [
      { employeeId: inactiveEmployee },
      { employeeId: outsiderEmployee },
      {
        employeeId: colleagueEmployee,
        visitId: "00000000-0000-4000-8000-000000000000",
      },
    ]) {
      expect(
        (await assign(assignedJob, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    // The database refuses a visit of a different job outright.
    await expect(
      db.assignment.create({
        data: {
          companyId,
          jobId: assignedJob,
          employeeId: colleagueEmployee,
          visitId,
          createdBy: userIds.owner,
        },
      }),
    ).rejects.toThrow();
  });

  it("is refused to accountant, employees and subcontractors (403), and across tenants (404)", async () => {
    for (const who of ["accountant", "worker", "subcontractor"] as const)
      expect(
        (await assign(assignedJob, { employeeId: colleagueEmployee }, who))
          .status,
        who,
      ).toBe(403);
    expect(
      (await assign(outsiderJob, { employeeId: workerEmployee }, "owner"))
        .status,
    ).toBe(404);
  });
});

describe("employee-scoped jobs", () => {
  it("lists only the employee's own assigned jobs", async () => {
    expect((await myIds("worker")).sort()).toEqual(
      [assignedJob, visitJob].sort(),
    );
    expect(await myIds("colleague")).toEqual([unassignedJob]);
    expect(await myIds("subcontractor")).toEqual([]);
  });

  it("returns not-found for any job not assigned to them, by id", async () => {
    for (const id of [
      unassignedJob,
      outsiderJob,
      "00000000-0000-4000-8000-000000000000",
      "x",
    ]) {
      expect(
        (await r().myRead(call("worker", "GET"), one(id))).status,
        id,
      ).toBe(404);
    }
    expect(
      (await r().myRead(call("worker", "GET"), one(assignedJob))).status,
    ).toBe(200);
  });

  it("never includes customer price, cost or profit fields (response shape)", async () => {
    const list = await (
      await r().myList(call("worker", "GET"), undefined)
    ).json();
    const detail = await (
      await r().myRead(call("worker", "GET"), one(assignedJob))
    ).json();
    for (const body of [list, detail]) {
      const keys = allKeys(body);
      expect(
        keys.filter((key) =>
          /price|cents|cost|profit|margin|rate|amount/i.test(key),
        ),
      ).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("250000");
    }
    expect(Object.keys(detail).sort()).toEqual(
      [
        "customerName",
        "description",
        "dueOn",
        "id",
        "reference",
        "site",
        "status",
        "title",
        "visits",
      ].sort(),
    );
    expect(detail.site).toMatchObject({
      addressLine1: "1 Sample Street",
      accessNotes: "Gate code from office",
    });
    // Employees still can't use the office job API at all.
    expect(
      (await r().officeRead(call("worker", "GET"), one(assignedJob))).status,
    ).toBe(403);
  });

  it("drops the job from the employee's view once the assignment ends (history kept)", async () => {
    const detail = await (
      await r().officeRead(call("manager", "GET"), one(assignedJob))
    ).json();
    const assignmentId = detail.assignments[0].id;
    const ended = await r().end(call("manager", "PATCH", { ended: true }), {
      params: Promise.resolve({ id: assignedJob, assignmentId }),
    });
    expect(ended.status).toBe(200);
    expect((await ended.json()).endedAt).not.toBeNull();
    expect(await myIds("worker")).toEqual([visitJob]);
    expect(
      (await r().myRead(call("worker", "GET"), one(assignedJob))).status,
    ).toBe(404);
    expect(await db.assignment.count({ where: { jobId: assignedJob } })).toBe(
      1,
    );
    expect(
      (
        await r().end(call("manager", "PATCH", { ended: true }), {
          params: Promise.resolve({ id: assignedJob, assignmentId }),
        })
      ).status,
    ).toBe(409);
    // Re-assigning after the end is allowed (a new live row).
    expect(
      (await assign(assignedJob, { employeeId: workerEmployee })).status,
    ).toBe(201);
  });

  it("stops showing jobs to a deactivated employee record", async () => {
    await db.employee.update({
      where: { id: colleagueEmployee },
      data: { isActive: false },
    });
    expect(await myIds("colleague")).toEqual([]);
  });
});

describe("assignment concurrency", () => {
  it("ends an assignment once even when two managers end it at the same time", async () => {
    const created = await assign(unassignedJob, { employeeId: workerEmployee });
    expect(created.status).toBe(201);
    const assignmentId = (await created.json()).id;
    const results = await Promise.all(
      [1, 2].map(() =>
        r().end(call("manager", "PATCH", { ended: true }), {
          params: Promise.resolve({ id: unassignedJob, assignmentId }),
        }),
      ),
    );
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const events = await db.auditEvent.findMany({
      where: { companyId, action: "job.unassigned", targetId: unassignedJob },
    });
    expect(
      events.filter((event) =>
        JSON.stringify(event.metadata).includes(assignmentId),
      ),
    ).toHaveLength(1);
  });
});

describe("visit visibility and assignment refusal", () => {
  it("hides other visits for visit-only assignments, while whole-job assignments include them", async () => {
    const extra = await db.jobVisit.create({
      data: {
        companyId,
        jobId: visitJob,
        createdBy: userIds.owner,
        startsAt: new Date("2026-11-03T22:00:00Z"),
      },
    });
    const onlyMine = await (
      await r().myRead(call("worker", "GET"), one(visitJob))
    ).json();
    expect(onlyMine.visits.map((row: { id: string }) => row.id)).toEqual([
      visitId,
    ]);
    expect(
      (await assign(visitJob, { employeeId: workerEmployee })).status,
    ).toBe(201);
    const whole = await (
      await r().myRead(call("worker", "GET"), one(visitJob))
    ).json();
    expect(whole.visits.map((row: { id: string }) => row.id).sort()).toEqual(
      [visitId, extra.id].sort(),
    );
  });

  it("refuses assignment on a terminal job without writing an audit event", async () => {
    const original = await db.job.findUniqueOrThrow({
      where: { id: unassignedJob },
    });
    const job = await db.job.create({
      data: {
        companyId,
        customerId: original.customerId,
        createdBy: userIds.owner,
        number: 90,
        reference: "JOB-90",
        title: "Terminal fixture",
        status: "cancelled",
      },
    });
    const before = await db.auditEvent.count({ where: { targetId: job.id } });
    expect((await assign(job.id, { employeeId: workerEmployee })).status).toBe(
      409,
    );
    expect(await db.assignment.count({ where: { jobId: job.id } })).toBe(0);
    expect(await db.auditEvent.count({ where: { targetId: job.id } })).toBe(
      before,
    );
  });
});

it("rechecks employee deactivation after a stale assignment preflight", async () => {
  const employee = await db.employee.create({
    data: {
      companyId,
      createdBy: userIds.owner,
      name: "Concurrent eligibility fixture",
    },
  });
  let announce!: () => void;
  let resume!: () => void;
  const observed = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const employeeProxy = new Proxy(db.employee, {
    get(target, property, receiver) {
      if (property === "findFirst")
        return async (...args: Parameters<typeof db.employee.findFirst>) => {
          const before = await db.employee.findFirst(...args);
          announce();
          await released;
          return before;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const wrapped = new Proxy(db, {
    get(target, property, receiver) {
      return property === "employee"
        ? employeeProxy
        : Reflect.get(target, property, receiver);
    },
  });
  const handler = assignmentHandlers(() => wrapped);
  const pending = withPolicy("job.assign", handler.assign)(
    call("manager", "POST", { employeeId: employee.id }),
    one(unassignedJob),
  );
  try {
    await observed;
    await db.employee.update({
      where: { id: employee.id },
      data: { isActive: false },
    });
  } finally {
    resume();
  }
  expect((await pending).status).toBe(400);
  expect(
    await db.assignment.count({ where: { employeeId: employee.id } }),
  ).toBe(0);
});
