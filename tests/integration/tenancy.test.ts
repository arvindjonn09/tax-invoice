import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabaseClient } from "../../packages/database/src/index";

if (
  !/^jobflow_test_[a-f0-9]{32}$/.test(
    process.env.JOBFLOW_ISOLATED_TEST_DATABASE ?? "",
  )
) {
  throw new Error("Use pnpm test:integration for an isolated database");
}
const client = createDatabaseClient(process.env.DATABASE_URL ?? "");
afterAll(() => client.$disconnect());
const userA = randomUUID();
const userB = randomUUID();
const companyA = randomUUID();
const companyB = randomUUID();

beforeAll(async () => {
  // Company creator FK is deferred: users -> companies -> first owner memberships.
  await client.$transaction(async (tx) => {
    await tx.user.createMany({
      data: [
        { id: userA, email: `${userA}@example.test` },
        { id: userB, email: `${userB}@example.test` },
      ],
    });
    await tx.company.createMany({
      data: [
        {
          id: companyA,
          name: "Synthetic Company A",
          createdBy: userA,
          isDemo: true,
        },
        {
          id: companyB,
          name: "Synthetic Company B",
          createdBy: userB,
          isDemo: true,
        },
      ],
    });
    await tx.membership.createMany({
      data: [
        { companyId: companyA, userId: userA, createdBy: userA, role: "owner" },
        { companyId: companyB, userId: userB, createdBy: userB, role: "owner" },
      ],
    });
  });
});

it("stores UTC instants, demo status and company-scoped roles", async () => {
  const company = await client.company.findUniqueOrThrow({
    where: { id: companyA },
  });
  expect(company.isDemo).toBe(true);
  expect(company.createdAt).toBeInstanceOf(Date);
  const member = await client.membership.findUniqueOrThrow({
    where: { companyId_userId: { companyId: companyA, userId: userA } },
  });
  expect(member.role).toBe("owner");
  const rows = await client.$queryRaw<
    { type: string }[]
  >`SELECT data_type AS type FROM information_schema.columns WHERE table_name = 'audit_events' AND column_name = 'created_at'`;
  expect(rows).toEqual([{ type: "timestamp with time zone" }]);
});

it("refuses a company without a creator membership at transaction commit", async () => {
  await expect(
    client.company.create({ data: { name: "Orphan", createdBy: userA } }),
  ).rejects.toThrow();
  expect(await client.company.count({ where: { name: "Orphan" } })).toBe(0);
});

it("rejects duplicate company membership while allowing one identity in two companies", async () => {
  await expect(
    client.membership.create({
      data: {
        companyId: companyA,
        userId: userA,
        createdBy: userA,
        role: "manager",
      },
    }),
  ).rejects.toThrow();
  const second = await client.membership.create({
    data: {
      companyId: companyB,
      userId: userA,
      createdBy: userB,
      role: "accountant",
    },
  });
  expect(second.role).toBe("accountant");
});

it("rejects cross-company creators on memberships, audit events and idempotency keys", async () => {
  const other = await client.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  await expect(
    client.membership.create({
      data: {
        companyId: companyA,
        userId: other.id,
        createdBy: userB,
        role: "employee",
      },
    }),
  ).rejects.toThrow();
  await expect(
    client.auditEvent.create({
      data: {
        companyId: companyA,
        createdBy: userB,
        action: "test",
        targetType: "company",
        targetId: companyA,
      },
    }),
  ).rejects.toThrow();
  await expect(
    client.idempotencyKey.create({
      data: {
        companyId: companyA,
        createdBy: userB,
        key: "cross-company",
        requestHash: "a".repeat(64),
      },
    }),
  ).rejects.toThrow();
});

it.each([
  "UPDATE audit_events SET action = 'changed'",
  "DELETE FROM audit_events",
  "TRUNCATE audit_events",
  "UPDATE audit_events SET action = 'changed' WHERE false",
  "DELETE FROM audit_events WHERE false",
])("blocks audit mutation: %s", async (sql) => {
  await client.auditEvent.create({
    data: {
      companyId: companyA,
      createdBy: userA,
      action: "test.created",
      targetType: "company",
      targetId: companyA,
      metadata: { synthetic: true },
    },
  });
  const before = await client.auditEvent.count();
  await expect(client.$executeRawUnsafe(sql)).rejects.toThrow("append-only");
  expect(await client.auditEvent.count()).toBe(before);
});

it("retains audit actors when membership is deactivated and prevents deleting their history", async () => {
  await client.auditEvent.create({
    data: {
      companyId: companyB,
      createdBy: userB,
      action: "test.created",
      targetType: "company",
      targetId: companyB,
    },
  });
  await client.membership.update({
    where: { companyId_userId: { companyId: companyB, userId: userB } },
    data: { isActive: false },
  });
  expect(
    await client.auditEvent.count({
      where: { companyId: companyB, createdBy: userB },
    }),
  ).toBe(1);
  await expect(
    client.membership.delete({
      where: { companyId_userId: { companyId: companyB, userId: userB } },
    }),
  ).rejects.toThrow();
  await expect(
    client.company.delete({ where: { id: companyB } }),
  ).rejects.toThrow();
});

it("makes idempotency keys unique per company and persists a completed outcome", async () => {
  const data = {
    companyId: companyA,
    createdBy: userA,
    key: "synthetic-operation",
    requestHash: "a".repeat(64),
  };
  const first = await client.idempotencyKey.create({ data });
  await expect(client.idempotencyKey.create({ data })).rejects.toThrow();
  await client.idempotencyKey.create({
    data: { ...data, companyId: companyB, createdBy: userB },
  });
  const complete = await client.idempotencyKey.update({
    where: { id: first.id },
    data: {
      state: "completed",
      responseStatus: 201,
      responseBody: { syntheticId: "fake-123" },
    },
  });
  expect(complete.responseBody).toEqual({ syntheticId: "fake-123" });
  expect(complete.responseStatus).toBe(201);
  expect(complete.updatedAt.getTime()).toBeGreaterThanOrEqual(
    first.updatedAt.getTime(),
  );
});

it("checks normalized identities, nonempty labels, valid roles and idempotency outcomes", async () => {
  await expect(
    client.user.create({ data: { email: "MixedCase@example.test" } }),
  ).rejects.toThrow();
  await expect(
    client.company.update({ where: { id: companyA }, data: { name: " " } }),
  ).rejects.toThrow();
  await expect(
    client.$executeRaw`UPDATE memberships SET role = 'admin' WHERE company_id = ${companyA}::uuid`,
  ).rejects.toThrow();
  const data = {
    companyId: companyA,
    createdBy: userA,
    key: "invalid-outcome",
    requestHash: "a".repeat(64),
  };
  await expect(
    client.idempotencyKey.create({ data: { ...data, state: "completed" } }),
  ).rejects.toThrow();
  await expect(
    client.idempotencyKey.create({ data: { ...data, responseStatus: 200 } }),
  ).rejects.toThrow();
  await expect(
    client.idempotencyKey.create({ data: { ...data, requestHash: "invalid" } }),
  ).rejects.toThrow();
  await expect(
    client.idempotencyKey.create({ data: { ...data, key: " " } }),
  ).rejects.toThrow();
  await expect(
    client.idempotencyKey.create({
      data: {
        ...data,
        state: "completed",
        responseStatus: 999,
        responseBody: {},
      },
    }),
  ).rejects.toThrow();
});

it("arbitrates concurrent idempotency inserts with one winning record", async () => {
  const data = {
    companyId: companyA,
    createdBy: userA,
    key: "concurrent-operation",
    requestHash: "b".repeat(64),
  };
  const results = await Promise.allSettled([
    client.idempotencyKey.create({ data }),
    client.idempotencyKey.create({ data }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(
    await client.idempotencyKey.count({
      where: { companyId: companyA, key: data.key },
    }),
  ).toBe(1);
});

it.each([
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const)("supports company role %s", async (role) => {
  const user = await client.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  const member = await client.membership.create({
    data: { companyId: companyA, userId: user.id, createdBy: userA, role },
  });
  expect(member.role).toBe(role);
});

it.each(["employee", "subcontractor", "manager", "accountant"] as const)(
  "refuses a self-created non-owner bootstrap role %s",
  async (role) => {
    const person = await client.user.create({
      data: { email: `${randomUUID()}@example.test` },
    });
    await expect(
      client.$transaction(async (tx) => {
        const company = await tx.company.create({
          data: { name: "Invalid bootstrap", createdBy: person.id },
        });
        await tx.membership.create({
          data: {
            companyId: company.id,
            userId: person.id,
            createdBy: person.id,
            role,
          },
        });
      }),
    ).rejects.toThrow("bootstrap owner");
    expect(
      await client.company.count({ where: { name: "Invalid bootstrap" } }),
    ).toBe(0);
  },
);

it("refuses inactive or additional self-created owners", async () => {
  const person = await client.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  await expect(
    client.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: { name: "Inactive bootstrap", createdBy: person.id },
      });
      await tx.membership.create({
        data: {
          companyId: company.id,
          userId: person.id,
          createdBy: person.id,
          role: "owner",
          isActive: false,
        },
      });
    }),
  ).rejects.toThrow("bootstrap owner");
  await expect(
    client.membership.create({
      data: {
        companyId: companyA,
        userId: person.id,
        createdBy: person.id,
        role: "owner",
      },
    }),
  ).rejects.toThrow("bootstrap owner");
});
