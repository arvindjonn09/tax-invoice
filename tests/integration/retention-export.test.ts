import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../packages/database/src/generated/prisma/client";
import { createAuth } from "../../apps/web/src/server/auth/config";
import { createCredentialUser } from "../../apps/web/src/server/auth/credentials";
import { createWithPolicy } from "../../apps/web/src/server/authz/policy";
import {
  companyExportHandler,
  decodeCompanyExport,
  decodeValue,
  exportCompany,
} from "../../apps/web/src/server/company/export";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #62: records are kept for their retention period, and a company can take
// all of its records out in one lossless file.
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "correct horse battery staple";
const WHO = ["owner", "accountant", "manager", "employee", "outsider"] as const;
type Who = (typeof WHO)[number];
const YEAR = 365.25 * 24 * 60 * 60 * 1000;
const yearsAgo = (years: number) => new Date(Date.now() - years * YEAR);

let database: CommittedDatabase;
let db: PrismaClient;
let withPolicy: ReturnType<typeof createWithPolicy>;
let companyId = "";
let otherCompanyId = "";
const userIds = {} as Record<Who, string>;
const cookies = {} as Record<Who, Headers>;
const factory = syntheticFactory(0x6262);

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
  for (const key of WHO)
    userIds[key] = (
      await createCredentialUser(db, {
        email: `${key}@jobflow.invalid`,
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
  otherCompanyId = other.id;
  for (const role of ["accountant", "manager", "employee"] as const)
    await db.membership.create({
      data: {
        companyId,
        userId: userIds[role],
        createdBy: userIds.owner,
        role,
      },
    });
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

const customer = (name: string, changed: Date, company = companyId) =>
  db.customer.create({
    data: {
      companyId: company,
      createdBy: company === companyId ? userIds.owner : userIds.outsider,
      name,
      createdAt: changed,
      updatedAt: changed,
    },
  });

describe("record retention (#62)", () => {
  it("refuses deleting business records younger than 5 years", async () => {
    const recent = await customer("Recent Sample", yearsAgo(4.9));
    await expect(
      db.customer.delete({ where: { id: recent.id } }),
    ).rejects.toThrow(/jobflow_retention_period/);
    const old = await customer("Old Sample", yearsAgo(5.1));
    await expect(
      db.customer.delete({ where: { id: old.id } }),
    ).resolves.toMatchObject({ id: old.id });
  });

  it("keeps employee (workplace) records for 7 years", async () => {
    const employee = (years: number) =>
      db.employee.create({
        data: {
          companyId,
          createdBy: userIds.owner,
          name: `Synthetic worker ${years}`,
          createdAt: yearsAgo(years),
          updatedAt: yearsAgo(years),
        },
      });
    const six = await employee(6);
    await expect(db.employee.delete({ where: { id: six.id } })).rejects.toThrow(
      /jobflow_retention_period/,
    );
    const eight = await employee(8);
    await expect(
      db.employee.delete({ where: { id: eight.id } }),
    ).resolves.toMatchObject({ id: eight.id });
  });

  it("counts from the last change, not creation", async () => {
    const touched = await db.customer.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        name: "Touched Sample",
        createdAt: yearsAgo(9),
        updatedAt: yearsAgo(1),
      },
    });
    await expect(
      db.customer.delete({ where: { id: touched.id } }),
    ).rejects.toThrow(/jobflow_retention_period/);
  });
});

it("keeps assignments for five years after assignment or its later end", async () => {
  const c = await customer("Synthetic assignment customer", new Date());
  const job = await db.job.create({
    data: {
      companyId,
      customerId: c.id,
      number: 62,
      reference: "JOB-62-RETENTION",
      title: "Synthetic assignment retention",
      createdBy: userIds.owner,
    },
  });
  const employee = await db.employee.create({
    data: {
      companyId,
      name: "Synthetic assigned worker",
      createdBy: userIds.owner,
    },
  });
  const assignment = (assignedAt: Date, endedAt: Date | null) =>
    db.assignment.create({
      data: {
        companyId,
        jobId: job.id,
        employeeId: employee.id,
        createdBy: userIds.owner,
        assignedAt,
        endedAt,
        endedBy: endedAt ? userIds.owner : null,
      },
    });
  const recent = await assignment(yearsAgo(0.1), null);
  await expect(
    db.assignment.delete({ where: { id: recent.id } }),
  ).rejects.toThrow(/jobflow_retention_period/);
  const endedRecently = await assignment(yearsAgo(6), yearsAgo(1));
  await expect(
    db.assignment.delete({ where: { id: endedRecently.id } }),
  ).rejects.toThrow(/jobflow_retention_period/);
  const old = await assignment(yearsAgo(7), yearsAgo(6));
  await expect(
    db.assignment.delete({ where: { id: old.id } }),
  ).resolves.toMatchObject({ id: old.id });
});

describe("full company export (#62)", () => {
  it("omits the private document deletion outbox even with owner DB access", async () => {
    await expect(
      db.$transaction(async (tx) => {
        // This table comes from #170; create it inside a rolled-back test
        // transaction while the two branches are being reviewed separately.
        await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS document_delete_retries (
          id uuid PRIMARY KEY, company_id uuid NOT NULL, object_key text NOT NULL)`);
        await tx.$executeRaw`
          INSERT INTO document_delete_retries(id, company_id, object_key)
          VALUES (gen_random_uuid(), ${companyId}::uuid, 'private-documents/secret-object-key')`;
        const exportData = await exportCompany(tx, companyId);
        expect(exportData.tables).not.toHaveProperty("document_delete_retries");
        expect(JSON.stringify(exportData)).not.toContain("secret-object-key");
        throw new Error("rollback private outbox fixture");
      }),
    ).rejects.toThrow("rollback private outbox fixture");
  });

  const download = (who: Who) => {
    const h = new Headers(cookies[who]);
    h.set("origin", ORIGIN);
    return withPolicy(
      "export.run",
      companyExportHandler(() => db),
    )(new Request(`${ORIGIN}/api/company/export`, { headers: h }), undefined);
  };

  it("requires permission to export protected cost-rate records", async () => {
    expect((await download("accountant")).status).toBe(403);
    expect((await download("manager")).status).toBe(403);
    expect((await download("employee")).status).toBe(403);
  });

  it("exports every company record losslessly, without secrets or other tenants", async () => {
    await customer("Export Sample", new Date());
    await customer("Their Sample", new Date(), otherCompanyId);
    const job = await db.job.create({
      data: {
        companyId,
        createdBy: userIds.owner,
        customerId: (await customer("Job Sample", new Date())).id,
        number: 1,
        reference: "JOB-62-1",
        title: "Synthetic exported job",
        agreedPriceExclusiveCents: 1_000_000_000_000n, // the largest allowed price
      },
    });
    await db.document.create({
      data: {
        companyId,
        kind: "tax_invoice",
        objectKey: `documents/${companyId}/${randomBytes(32).toString("hex")}`,
        fileName: "synthetic.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        sha256: "b".repeat(64),
        createdBy: userIds.owner,
      },
    });
    await db.userInvitation.create({
      data: {
        companyId,
        email: "invitee@jobflow.invalid",
        role: "employee",
        tokenHash: "c".repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
        createdBy: userIds.owner,
      },
    });

    const response = await download("owner");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="jobflow-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const text = await response.text();
    // Secrets and internal keys never leave; neither does another tenant.
    expect(text).not.toContain("c".repeat(64));
    expect(text).not.toContain(`documents/${companyId}/`);
    expect(text).not.toContain("Their Sample");
    expect(text).not.toMatch(/password|request_hash|token_hash|object_key/);
    const raw = JSON.parse(text);
    expect(raw).toMatchObject({
      format: "jobflow.company-export",
      version: 1,
      companyId,
    });
    expect(raw.tables.users.rows).toHaveLength(4);
    expect(
      raw.tables.jobs.rows.find((r: { id: string }) => r.id === job.id)
        .agreed_price_exclusive_cents,
    ).toBe("1000000000000");

    // Round trip: every exported table decodes back to exactly what the
    // database holds for this company (bigint, numeric, dates, JSON).
    const decoded = decodeCompanyExport(text);
    for (const [table, rows] of Object.entries(decoded)) {
      if (table === "companies" || table === "users") continue;
      const columns = raw.tables[table].columns as { name: string }[];
      const order = columns.some((c) => c.name === "id")
        ? ' ORDER BY "id"'
        : "";
      const expected = await db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ${columns.map((c) => `"${c.name}"`).join(", ")} FROM "${table}" WHERE company_id = $1::uuid${order}`,
        companyId,
      );
      // The export's own audit event is written after its snapshot.
      const before = expected.filter(
        (row) =>
          table !== "audit_events" ||
          (row.created_at as Date) <= new Date(raw.exportedAt),
      );
      expect(rows, table).toEqual(before);
    }
    expect(decoded.jobs!.find((r) => r.id === job.id)).toMatchObject({
      agreed_price_exclusive_cents: 1_000_000_000_000n,
    });
    expect(decoded.companies).toHaveLength(1);
    expect(Object.keys(decoded)).toEqual(
      expect.arrayContaining([
        "customers",
        "jobs",
        "documents",
        "audit_events",
      ]),
    );
    expect(() => decodeCompanyExport('{"format":"other"}')).toThrow();
    // Cents travel as strings, so even values beyond 2^53 stay exact.
    expect(decodeValue("9007199254740993", "bigint")).toBe(
      9_007_199_254_740_993n,
    );

    // The export itself is audited.
    expect(
      await db.auditEvent.findFirst({
        where: { companyId, action: "company.exported" },
      }),
    ).toMatchObject({ createdBy: userIds.owner });
  });
});
