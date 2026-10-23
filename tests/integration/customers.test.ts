import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import { customerHandlers } from "../../apps/web/src/server/customers/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #28: customer directory with contacts and service locations — tenant
// isolation, archive (never delete), Zod validation, audited writes.
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
let handlers: ReturnType<typeof customerHandlers>;
let companyId = "";
let otherCustomerId = "";
let otherLocationId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x2828);

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
  handlers = customerHandlers(() => db);
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
  const otherCustomer = await db.customer.create({
    data: {
      companyId: other.id,
      createdBy: userIds.outsider,
      name: "Other Company Client",
    },
  });
  otherCustomerId = otherCustomer.id;
  otherLocationId = (
    await db.location.create({
      data: {
        companyId: other.id,
        customerId: otherCustomer.id,
        createdBy: userIds.outsider,
        addressLine1: "9 Other Road",
        suburb: "Elsewhere",
        state: "VIC",
        postcode: "3000",
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

function call(who: Who, method: string, body?: unknown, query = ""): Request {
  const headers = new Headers(cookies[who]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/customers${query}`, init);
}
const one = (id: string) => ({ params: Promise.resolve({ id }) });
const child = (id: string, childId: string) => ({
  params: Promise.resolve({ id, childId }),
});
type One = { params: Promise<{ id: string }> };
type Child = { params: Promise<{ id: string; childId: string }> };
const r = () => ({
  list: withPolicy("customer.read", handlers.list),
  create: withPolicy("customer.write", handlers.create),
  read: withPolicy<One>("customer.read", handlers.read),
  update: withPolicy<One>("customer.write", handlers.update),
  addContact: withPolicy<One>("customer.write", handlers.addContact),
  updateContact: withPolicy<Child>("customer.write", handlers.updateContact),
  addLocation: withPolicy<One>("customer.write", handlers.addLocation),
  updateLocation: withPolicy<Child>("customer.write", handlers.updateLocation),
});
const ids = async (response: Response, key: string) =>
  ((await response.json())[key] as { id: string }[]).map((row) => row.id);

describe("customers", () => {
  let acmeId = "";
  let contactA = "";
  let contactB = "";
  let siteId = "";

  it("creates a customer with optional ABN and billing details, audited; forged companyId ignored", async () => {
    const abn = syntheticAbn("135792468");
    const response = await r().create(
      call("manager", "POST", {
        name: "Acme Sample Pty Ltd",
        abn: `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`,
        billingEmail: "accounts@acme.jobflow.invalid",
        billingPhone: "02 0000 0000",
        state: "NSW",
        postcode: "2000",
        companyId: otherCustomerId,
      }),
      undefined,
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    acmeId = body.id;
    expect(body).toMatchObject({ abn, archivedAt: null });
    const row = await db.customer.findUniqueOrThrow({ where: { id: acmeId } });
    expect(row.companyId).toBe(companyId);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { companyId, action: "customer.created", targetId: acmeId },
    });
    expect(JSON.stringify(event.metadata)).not.toContain(abn);
    expect(JSON.stringify(event.metadata)).not.toContain("accounts@acme");

    expect(
      (
        await r().create(
          call("owner", "POST", { name: "Bravo Sample" }),
          undefined,
        )
      ).status,
    ).toBe(201);
  });

  it("validates every write with Zod", async () => {
    const bad = syntheticAbn("135792468").replace(/.$/, (d) =>
      String((Number(d) + 1) % 10),
    );
    for (const body of [
      {},
      { name: " " },
      { name: "X", abn: bad },
      { name: "X", billingEmail: "nope" },
      { name: "X", state: "ZZ" },
      { name: "X", postcode: "123" },
    ]) {
      expect(
        (await r().create(call("owner", "POST", body), undefined)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (
        await r().addLocation(
          call("owner", "POST", { addressLine1: "1 St" }),
          one(acmeId),
        )
      ).status,
    ).toBe(400);
    expect(
      (await r().update(call("owner", "PATCH", {}), one(acmeId))).status,
    ).toBe(400);
  });

  it("adds contacts (one primary at a time) and service locations", async () => {
    const a = await r().addContact(
      call("owner", "POST", {
        name: "Pat Sample",
        email: "pat@acme.jobflow.invalid",
        isPrimary: true,
      }),
      one(acmeId),
    );
    expect(a.status).toBe(201);
    contactA = (await a.json()).id;
    const b = await r().addContact(
      call("manager", "POST", { name: "Sam Sample", isPrimary: true }),
      one(acmeId),
    );
    contactB = (await b.json()).id;
    const site = await r().addLocation(
      call("manager", "POST", {
        label: "Head office",
        addressLine1: "1 Sample Street",
        suburb: "Sampleton",
        state: "NSW",
        postcode: "2000",
        accessNotes: "Side gate",
      }),
      one(acmeId),
    );
    expect(site.status).toBe(201);
    siteId = (await site.json()).id;

    const detail = await (
      await r().read(call("accountant", "GET"), one(acmeId))
    ).json();
    expect(
      detail.contacts.map((c: { id: string; isPrimary: boolean }) => [
        c.id,
        c.isPrimary,
      ]),
    ).toEqual([
      [contactB, true],
      [contactA, false],
    ]);
    expect(detail.locations).toEqual([
      expect.objectContaining({ id: siteId, label: "Head office" }),
    ]);
  });

  it("archives (never deletes): hidden from pickers, still readable with history", async () => {
    const archived = await r().update(
      call("owner", "PATCH", { archived: true }),
      one(acmeId),
    );
    expect((await archived.json()).archivedAt).not.toBeNull();
    expect(
      await ids(await r().list(call("owner", "GET"), undefined), "customers"),
    ).not.toContain(acmeId);
    expect(
      await ids(
        await r().list(
          call("owner", "GET", undefined, "?status=archived"),
          undefined,
        ),
        "customers",
      ),
    ).toEqual([acmeId]);
    expect((await r().read(call("owner", "GET"), one(acmeId))).status).toBe(
      200,
    );
    expect(await db.customer.count({ where: { id: acmeId } })).toBe(1);
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "customer.archived" },
      }),
    ).toBe(1);

    await r().update(call("owner", "PATCH", { archived: false }), one(acmeId));
    expect(
      await db.auditEvent.count({
        where: { companyId, action: "customer.restored" },
      }),
    ).toBe(1);

    const contact = await r().updateContact(
      call("owner", "PATCH", { archived: true }),
      child(acmeId, contactA),
    );
    expect((await contact.json()).archivedAt).not.toBeNull();
    const location = await r().updateLocation(
      call("owner", "PATCH", { archived: true }),
      child(acmeId, siteId),
    );
    expect((await location.json()).archivedAt).not.toBeNull();
  });

  it("refuses writes to accountant/employee/subcontractor and reads to employee/subcontractor", async () => {
    for (const role of ["accountant", "employee", "subcontractor"] as const) {
      expect(
        (await r().create(call(role, "POST", { name: "Nope" }), undefined))
          .status,
        role,
      ).toBe(403);
      expect(
        (await r().update(call(role, "PATCH", { name: "Nope" }), one(acmeId)))
          .status,
        role,
      ).toBe(403);
    }
    for (const role of ["employee", "subcontractor"] as const) {
      expect((await r().list(call(role, "GET"), undefined)).status, role).toBe(
        403,
      );
      expect(
        (await r().read(call(role, "GET"), one(acmeId))).status,
        role,
      ).toBe(403);
    }
  });

  it("isolates tenants: no read, update, child add or child edit across companies", async () => {
    const outsider = await ids(
      await r().list(
        call("outsider", "GET", undefined, "?status=all"),
        undefined,
      ),
      "customers",
    );
    expect(outsider).toEqual([otherCustomerId]);
    for (const id of [
      otherCustomerId,
      "00000000-0000-4000-8000-000000000000",
      "x",
    ]) {
      expect((await r().read(call("owner", "GET"), one(id))).status, id).toBe(
        404,
      );
      expect(
        (await r().update(call("owner", "PATCH", { name: "Hijack" }), one(id)))
          .status,
        id,
      ).toBe(404);
      expect(
        (await r().addContact(call("owner", "POST", { name: "Spy" }), one(id)))
          .status,
        id,
      ).toBe(404);
    }
    // Another company's location id under our own customer → 404.
    expect(
      (
        await r().updateLocation(
          call("owner", "PATCH", { label: "Mine now" }),
          child(acmeId, otherLocationId),
        )
      ).status,
    ).toBe(404);
    // Our contact under another customer id (theirs) → 404.
    expect(
      (
        await r().updateContact(
          call("owner", "PATCH", { name: "Moved" }),
          child(otherCustomerId, contactB),
        )
      ).status,
    ).toBe(404);
    // The database refuses a cross-tenant child row outright.
    await expect(
      db.location.create({
        data: {
          companyId,
          customerId: otherCustomerId,
          createdBy: userIds.owner,
          addressLine1: "1 X St",
          suburb: "Y",
          state: "NSW",
          postcode: "2000",
        },
      }),
    ).rejects.toThrow();
    expect(
      (await db.customer.findUniqueOrThrow({ where: { id: otherCustomerId } }))
        .name,
    ).toBe("Other Company Client");
  });

  it("searches by name, suburb or ABN, paged within bounds", async () => {
    const byName = await (
      await r().list(
        call("owner", "GET", undefined, "?q=acme&pageSize=500"),
        undefined,
      )
    ).json();
    expect(byName.pageSize).toBe(100);
    expect(byName.customers.map((c: { id: string }) => c.id)).toEqual([acmeId]);
    const abn = syntheticAbn("135792468");
    const byAbn = await ids(
      await r().list(
        call(
          "owner",
          "GET",
          undefined,
          `?q=${encodeURIComponent(abn.slice(0, 5))}`,
        ),
        undefined,
      ),
      "customers",
    );
    expect(byAbn).toEqual([acmeId]);
    const paged = await (
      await r().list(
        call("owner", "GET", undefined, "?pageSize=1&page=2"),
        undefined,
      )
    ).json();
    expect(paged).toMatchObject({ page: 2, total: 2 });
  });
});
