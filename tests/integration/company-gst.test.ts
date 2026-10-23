import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  companyGstStatusOn,
  gstHandlers,
} from "../../apps/web/src/server/company/gst";
import { companyHandlers } from "../../apps/web/src/server/company/handlers";
import { syntheticAbn } from "../helpers/abn";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #25: company profile (ABN checksum, address, prefixes) and effective-dated
// GST registration — owner/accountant only, every change audited.
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
let company: ReturnType<typeof companyHandlers>;
let gst: ReturnType<typeof gstHandlers>;
let companyId = "";
let otherCompanyRegistration = "";
const userIds = {} as Record<Role | "outsider", string>;
const cookies = {} as Record<Role, Headers>;
const factory = syntheticFactory(0x2525);

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
  company = companyHandlers(() => db);
  gst = gstHandlers(() => db);
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
  otherCompanyRegistration = (
    await db.companyGstRegistration.create({
      data: {
        companyId: other.id,
        createdBy: userIds.outsider,
        startsOn: new Date("2025-07-01T00:00:00Z"),
        basis: "cash",
      },
    })
  ).id;
  let ip = 0;
  for (const role of ROLES) {
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: ORIGIN,
          "x-forwarded-for": `203.0.113.${(ip += 1)}`,
        },
        body: JSON.stringify({
          email: `${role}@jobflow.invalid`,
          password: PASSWORD,
        }),
      }),
    );
    expect(response.status).toBe(200);
    cookies[role] = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
  }
}, 90_000);
afterAll(() => database?.release());

function call(role: Role, method: string, body?: unknown): Request {
  const headers = new Headers(cookies[role]);
  headers.set("origin", ORIGIN);
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return new Request(`${ORIGIN}/api/company`, init);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const routes = () => ({
  readCompany: withPolicy("company.read", company.read),
  updateCompany: withPolicy("company.update", company.update),
  readGst: withPolicy("gst_settings.read", gst.read),
  setBas: withPolicy("gst_settings.update", gst.setBasPeriod),
  add: withPolicy("gst_settings.update", gst.addRegistration),
  change: withPolicy<{ params: Promise<{ id: string }> }>(
    "gst_settings.update",
    gst.changeRegistration,
  ),
});

async function auditCount(action: string) {
  return db.auditEvent.count({ where: { companyId, action } });
}

describe("company profile", () => {
  it("lets the owner set legal name, ABN, address and prefixes, stores the ABN as digits and audits it", async () => {
    const abn = syntheticAbn("246813579");
    const response = await routes().updateCompany(
      call("owner", "PATCH", {
        legalName: "Sample Contracting Pty Ltd",
        abn: `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`,
        addressLine1: "1 Sample Street",
        suburb: "Sampleton",
        state: "NSW",
        postcode: "2000",
        invoicePrefix: "SC-INV-",
        jobPrefix: "SC-",
        companyId: "00000000-0000-4000-8000-000000000000",
      }),
      undefined,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: companyId,
      legalName: "Sample Contracting Pty Ltd",
      abn,
      state: "NSW",
      invoicePrefix: "SC-INV-",
    });
    const event = await db.auditEvent.findFirstOrThrow({
      where: { companyId, action: "company.profile_updated" },
    });
    // The change is recorded; the ABN and address values are redacted.
    expect(JSON.stringify(event.metadata)).not.toContain(abn);
    expect(JSON.stringify(event.metadata)).not.toContain("Sample Street");
    expect(event.metadata).toMatchObject({
      changes: { legalName: { after: "Sample Contracting Pty Ltd" } },
    });
  });

  it("rejects an ABN with a bad checksum, bad state/postcode/prefix, and an empty update", async () => {
    const valid = syntheticAbn("246813579");
    const badAbn = `${valid.slice(0, 10)}${(Number(valid[10]) + 1) % 10}`;
    for (const body of [
      { abn: badAbn },
      { abn: "123" },
      { state: "XYZ" },
      { postcode: "20000" },
      { invoicePrefix: "has space" },
      {},
    ]) {
      const response = await routes().updateCompany(
        call("owner", "PATCH", body),
        undefined,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("lets only the owner update the profile", async () => {
    for (const role of ROLES.slice(1)) {
      const response = await routes().updateCompany(
        call(role, "PATCH", { name: "Takeover" }),
        undefined,
      );
      expect(response.status, role).toBe(403);
    }
  });

  it("shows legal and tax details only to owner and accountant", async () => {
    for (const role of ROLES) {
      const body = await (
        await routes().readCompany(call(role, "GET"), undefined)
      ).json();
      expect(body.name, role).toBeDefined();
      expect("abn" in body, role).toBe(
        role === "owner" || role === "accountant",
      );
    }
  });
});

describe("GST registration", () => {
  let current = "";

  it("is refused to managers, employees and subcontractors (403), reads included", async () => {
    for (const role of ["manager", "employee", "subcontractor"] as const) {
      expect(
        (await routes().readGst(call(role, "GET"), undefined)).status,
        role,
      ).toBe(403);
      expect(
        (
          await routes().add(
            call(role, "POST", { startsOn: "2025-07-01", basis: "cash" }),
            undefined,
          )
        ).status,
        role,
      ).toBe(403);
    }
  });

  it("lets the accountant add periods and answers 'registered on date X' at the boundaries", async () => {
    const first = await routes().add(
      call("accountant", "POST", {
        startsOn: "2025-07-01",
        endsOn: "2026-06-30",
        basis: "cash",
      }),
      undefined,
    );
    expect(first.status).toBe(201);
    const second = await routes().add(
      call("owner", "POST", { startsOn: "2026-07-01", basis: "non_cash" }),
      undefined,
    );
    expect(second.status).toBe(201);
    current = (await second.json()).id;
    expect(await auditCount("gst_settings.registration_added")).toBe(2);

    const on = (date: string) => companyGstStatusOn(db, companyId, date);
    expect(await on("2025-06-30")).toEqual({ registered: false, basis: null });
    expect(await on("2025-07-01")).toEqual({ registered: true, basis: "cash" });
    expect(await on("2026-06-30")).toEqual({ registered: true, basis: "cash" });
    expect(await on("2026-07-01")).toEqual({
      registered: true,
      basis: "non_cash",
    });

    const read = await (
      await routes().readGst(call("accountant", "GET"), undefined)
    ).json();
    expect(read.basPeriod).toBe("quarterly");
    expect(read.registrations).toEqual([
      expect.objectContaining({ startsOn: "2025-07-01", endsOn: "2026-06-30" }),
      expect.objectContaining({ startsOn: "2026-07-01", endsOn: null }),
    ]);
    expect(read.today).toHaveProperty("registered");
  });

  it("rejects overlapping periods (409) and bad dates (400) without writing", async () => {
    const before = await db.companyGstRegistration.count({
      where: { companyId },
    });
    for (const [body, status] of [
      [{ startsOn: "2026-06-30", basis: "cash" }, 409],
      [{ startsOn: "2024-01-01", endsOn: "2025-07-01", basis: "cash" }, 409],
      [{ startsOn: "2030-01-01", basis: "cash" }, 409],
      [{ startsOn: "2024-02-30", basis: "cash" }, 400],
      [{ startsOn: "2024-03-01", endsOn: "2024-02-01", basis: "cash" }, 400],
      [{ startsOn: "2024-03-01", basis: "accrual" }, 400],
    ] as const) {
      const response = await routes().add(
        call("owner", "POST", body),
        undefined,
      );
      expect(response.status, JSON.stringify(body)).toBe(status);
    }
    expect(
      await db.companyGstRegistration.count({ where: { companyId } }),
    ).toBe(before);
  });

  it("the database itself refuses overlaps, even for concurrent or direct writes", async () => {
    await expect(
      db.companyGstRegistration.create({
        data: {
          companyId,
          createdBy: userIds.owner,
          startsOn: new Date("2026-06-30T00:00:00Z"),
          endsOn: new Date("2026-06-30T00:00:00Z"),
          basis: "cash",
        },
      }),
    ).rejects.toThrow();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        routes().add(
          call("owner", "POST", {
            startsOn: "2020-01-01",
            endsOn: "2020-12-31",
            basis: "cash",
          }),
          undefined,
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it("ends an open period, audited; the change must not create an overlap", async () => {
    const ended = await routes().change(
      call("accountant", "PATCH", { endsOn: "2027-06-30" }),
      params(current),
    );
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ endsOn: "2027-06-30" });
    expect(await companyGstStatusOn(db, companyId, "2027-07-01")).toEqual({
      registered: false,
      basis: null,
    });
    expect(await auditCount("gst_settings.registration_changed")).toBe(1);

    const back = await routes().change(
      call("owner", "PATCH", { endsOn: "2026-06-30" }),
      params(current),
    );
    expect(back.status).toBe(400);
  });

  it("reports another company's or an unknown registration as 404", async () => {
    for (const id of [
      otherCompanyRegistration,
      "00000000-0000-4000-8000-000000000000",
      "not-a-uuid",
    ]) {
      const response = await routes().change(
        call("owner", "PATCH", { endsOn: "2030-01-01" }),
        params(id),
      );
      expect(response.status, id).toBe(404);
    }
  });

  it("changes the BAS period (owner/accountant), audited", async () => {
    const response = await routes().setBas(
      call("accountant", "PATCH", { basPeriod: "monthly" }),
      undefined,
    );
    expect(await response.json()).toEqual({ basPeriod: "monthly" });
    expect(await auditCount("gst_settings.bas_period_changed")).toBe(1);
    expect(
      (
        await routes().setBas(
          call("manager", "PATCH", { basPeriod: "quarterly" }),
          undefined,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await routes().setBas(
          call("owner", "PATCH", { basPeriod: "weekly" }),
          undefined,
        )
      ).status,
    ).toBe(400);
  });
});
