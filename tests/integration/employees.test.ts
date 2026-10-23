import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { employeeHandlers } from "../../apps/web/src/server/employees/handlers";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #30: employee records (no payroll) — owner/manager write, office reads,
// tenant isolation, user-account link limited to this company's members.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const ROLES = [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const;
type Role = (typeof ROLES)[number];

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let handlers: ReturnType<typeof employeeHandlers>;
let companyId = "";
let otherCompanyId = "";
let otherEmployeeId = "";
const userIds = {} as Record<Role | "outsider", string>;
const cookies = {} as Record<Role | "outsider", Headers>;
const factory = syntheticFactory(0x3030);

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
  handlers = employeeHandlers(() => db);
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
      await tx.company.create({ data: record });
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
  otherEmployeeId = (
    await db.employee.create({
      data: {
        companyId: otherCompanyId,
        createdBy: userIds.outsider,
        name: "Other Company Worker",
      },
    })
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

function call(
  who: Role | "outsider",
  method: string,
  body?: unknown,
  query = "",
): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/employees${query}`, init);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
type Ctx = { params: Promise<{ id: string }> };
const routes = () => ({
  list: withPolicy("employee.read", handlers.list),
  create: withPolicy("employee.write", handlers.create),
  read: withPolicy<Ctx>("employee.read", handlers.read),
  update: withPolicy<Ctx>("employee.write", handlers.update),
});

describe("employee records", () => {
  let alexId = "";

  it("lets owner and manager add employees, audited; a forged companyId is ignored", async () => {
    const created = await routes().create(
      call("manager", "POST", {
        name: "Alex Sample",
        email: "alex@jobflow.invalid",
        phone: "0400 000 000",
        companyId: otherCompanyId,
      }),
      undefined,
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    alexId = body.id;
    expect(body).toMatchObject({ name: "Alex Sample", isActive: true });
    expect(
      (await db.employee.findUniqueOrThrow({ where: { id: alexId } }))
        .companyId,
    ).toBe(companyId);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { companyId, action: "employee.created", targetId: alexId },
    });
    expect(event.createdBy).toBe(userIds.manager);

    expect(
      (
        await routes().create(
          call("owner", "POST", { name: "Bo Sample" }),
          undefined,
        )
      ).status,
    ).toBe(201);
  });

  it("refuses writes to accountant, employee and subcontractor (403) and reads to employee/subcontractor", async () => {
    for (const role of ["accountant", "employee", "subcontractor"] as const) {
      expect(
        (
          await routes().create(
            call(role, "POST", { name: "Sneaky" }),
            undefined,
          )
        ).status,
        role,
      ).toBe(403);
      expect(
        (
          await routes().update(
            call(role, "PATCH", { isActive: false }),
            params(alexId),
          )
        ).status,
        role,
      ).toBe(403);
    }
    for (const role of ["employee", "subcontractor"] as const) {
      expect(
        (await routes().list(call(role, "GET"), undefined)).status,
        role,
      ).toBe(403);
    }
    expect(
      (await routes().list(call("accountant", "GET"), undefined)).status,
    ).toBe(200);
  });

  it("validates input", async () => {
    for (const body of [
      {},
      { name: "   " },
      { name: "x".repeat(201) },
      { name: "Ok", email: "not-an-email" },
      { name: "Ok", phone: "call me" },
      { name: "Ok", userId: "nope" },
    ]) {
      expect(
        (await routes().create(call("owner", "POST", body), undefined)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it("links only to an active user account of this company, once", async () => {
    const linked = await routes().update(
      call("owner", "PATCH", { userId: userIds.employee }),
      params(alexId),
    );
    expect(linked.status).toBe(200);
    expect((await linked.json()).userId).toBe(userIds.employee);

    // Another company's user, or one already linked → 400.
    for (const userId of [userIds.outsider, userIds.employee]) {
      const response = await routes().create(
        call("owner", "POST", { name: "Link Test", userId }),
        undefined,
      );
      expect(response.status).toBe(400);
    }
    // The database refuses a cross-tenant link outright.
    await expect(
      db.employee.create({
        data: {
          companyId,
          createdBy: userIds.owner,
          name: "Direct",
          userId: userIds.outsider,
        },
      }),
    ).rejects.toThrow();

    const unlinked = await routes().update(
      call("owner", "PATCH", { userId: null }),
      params(alexId),
    );
    expect((await unlinked.json()).userId).toBeNull();
  });

  it("deactivates and reactivates (never deletes), with matching audit events", async () => {
    const off = await routes().update(
      call("manager", "PATCH", { isActive: false }),
      params(alexId),
    );
    expect((await off.json()).isActive).toBe(false);
    const listed = await (
      await routes().list(call("owner", "GET"), undefined)
    ).json();
    expect(listed.employees.map((e: { id: string }) => e.id)).not.toContain(
      alexId,
    );
    const inactive = await (
      await routes().list(
        call("owner", "GET", undefined, "?status=inactive"),
        undefined,
      )
    ).json();
    expect(inactive.employees.map((e: { id: string }) => e.id)).toEqual([
      alexId,
    ]);
    await routes().update(
      call("manager", "PATCH", { isActive: true }),
      params(alexId),
    );
    for (const action of ["employee.deactivated", "employee.reactivated"]) {
      expect(
        await db.auditEvent.count({ where: { companyId, action } }),
        action,
      ).toBe(1);
    }
    const contact = await db.auditEvent.findMany({
      where: { companyId, targetId: alexId },
    });
    expect(JSON.stringify(contact.map((e) => e.metadata))).not.toContain(
      "alex@jobflow.invalid",
    );
  });

  it("isolates tenants: other company's employees are invisible and 404", async () => {
    const outsiderList = await (
      await routes().list(
        call("outsider", "GET", undefined, "?status=all"),
        undefined,
      )
    ).json();
    expect(outsiderList.employees.map((e: { id: string }) => e.id)).toEqual([
      otherEmployeeId,
    ]);
    const ownList = await (
      await routes().list(
        call("owner", "GET", undefined, "?status=all"),
        undefined,
      )
    ).json();
    expect(ownList.employees.map((e: { id: string }) => e.id)).not.toContain(
      otherEmployeeId,
    );
    for (const id of [
      otherEmployeeId,
      "00000000-0000-4000-8000-000000000000",
      "nope",
    ]) {
      expect(
        (await routes().read(call("owner", "GET"), params(id))).status,
        id,
      ).toBe(404);
      expect(
        (
          await routes().update(
            call("owner", "PATCH", { name: "Hijack" }),
            params(id),
          )
        ).status,
        id,
      ).toBe(404);
    }
    expect(
      (await db.employee.findUniqueOrThrow({ where: { id: otherEmployeeId } }))
        .name,
    ).toBe("Other Company Worker");
  });

  it("searches and pages within bounds", async () => {
    const found = await (
      await routes().list(
        call("owner", "GET", undefined, "?q=alex&pageSize=1000"),
        undefined,
      )
    ).json();
    expect(found.pageSize).toBe(100);
    expect(found.employees.map((e: { name: string }) => e.name)).toEqual([
      "Alex Sample",
    ]);
    const paged = await (
      await routes().list(
        call("owner", "GET", undefined, "?pageSize=1&page=2"),
        undefined,
      )
    ).json();
    expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 2 });
    expect(paged.employees).toHaveLength(1);
  });
});
