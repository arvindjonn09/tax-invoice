import { expect, it as base } from "vitest";
import type { Prisma } from "../../packages/database/src/generated/prisma/client";
import { withTestDatabase } from "../helpers/database";
import { syntheticFactory } from "../helpers/factories";
import { expectRejectedWrite } from "../helpers/expect-rejected-write";

type Fixture = {
  client: Prisma.TransactionClient;
  userA: string;
  userB: string;
  companyA: string;
  companyB: string;
};
const it = base.extend<{ fixture: Fixture }>({
  fixture: async ({ task }, use) => {
    // Read task to make this a real Vitest fixture context; data is deterministic.
    if (!task.name) throw new Error("Missing test identity");
    await withTestDatabase(async (client) => {
      const factory = syntheticFactory(12);
      const first = factory.user();
      const second = factory.user();
      const a = factory.company(first.id);
      const b = factory.company(second.id);
      await client.user.createMany({ data: [first, second] });
      await client.company.createMany({ data: [a, b] });
      await client.membership.createMany({
        data: [
          factory.membership(a.id, first.id),
          factory.membership(b.id, second.id),
        ],
      });
      await client.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      // New company bootstrap checks in each test can still exercise deferred validation.
      await client.$executeRawUnsafe(
        "SET CONSTRAINTS companies_id_created_by_fkey DEFERRED",
      );
      await use({
        client,
        userA: first.id,
        userB: second.id,
        companyA: a.id,
        companyB: b.id,
      });
    });
  },
});

it("stores UTC instants, demo status and company-scoped roles", async ({
  fixture,
}) => {
  const { client, userA, companyA } = fixture;
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

it("rejects a company whose deferred creator membership remains missing", async ({
  fixture,
}) => {
  const { client, userA } = fixture;
  await expectRejectedWrite(client, async () => {
    await client.company.create({ data: { name: "Orphan", createdBy: userA } });
    await client.$executeRawUnsafe(
      "SET CONSTRAINTS companies_id_created_by_fkey IMMEDIATE",
    );
  });
  expect(await client.company.count({ where: { name: "Orphan" } })).toBe(0);
});

it("rejects duplicate company membership while allowing one identity in two companies", async ({
  fixture,
}) => {
  const { client, userA, userB, companyA, companyB } = fixture;
  await expectRejectedWrite(client, () =>
    client.membership.create({
      data: {
        companyId: companyA,
        userId: userA,
        createdBy: userA,
        role: "manager",
      },
    }),
  );
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

it("rejects cross-company creators on memberships, audit events and idempotency keys", async ({
  fixture,
}) => {
  const { client, userB, companyA } = fixture;
  const other = await client.user.create({
    data: { email: "additional-synthetic@example.test" },
  });
  await expectRejectedWrite(client, () =>
    client.membership.create({
      data: {
        companyId: companyA,
        userId: other.id,
        createdBy: userB,
        role: "employee",
      },
    }),
  );
  await expectRejectedWrite(client, () =>
    client.auditEvent.create({
      data: {
        companyId: companyA,
        createdBy: userB,
        action: "test",
        targetType: "company",
        targetId: companyA,
      },
    }),
  );
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({
      data: {
        companyId: companyA,
        createdBy: userB,
        key: "cross-company",
        requestHash: "a".repeat(64),
      },
    }),
  );
});

for (const sql of [
  "UPDATE audit_events SET action = 'changed'",
  "DELETE FROM audit_events",
  "TRUNCATE audit_events",
  "UPDATE audit_events SET action = 'changed' WHERE false",
  "DELETE FROM audit_events WHERE false",
]) {
  it(`blocks audit mutation: ${sql}`, async ({ fixture }) => {
    const { client, userA, companyA } = fixture;
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
    await expectRejectedWrite(
      client,
      () => client.$executeRawUnsafe(sql),
      "append-only",
    );
    expect(await client.auditEvent.count()).toBe(before);
  });
}

it("retains audit actors when membership is deactivated and prevents deleting their history", async ({
  fixture,
}) => {
  const { client, userB, companyB } = fixture;
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
  await expectRejectedWrite(client, () =>
    client.membership.delete({
      where: { companyId_userId: { companyId: companyB, userId: userB } },
    }),
  );
  await expectRejectedWrite(client, () =>
    client.company.delete({ where: { id: companyB } }),
  );
});

it("makes idempotency keys unique per company and persists a completed outcome", async ({
  fixture,
}) => {
  const { client, userA, userB, companyA, companyB } = fixture;
  const data = {
    companyId: companyA,
    createdBy: userA,
    key: "synthetic-operation",
    requestHash: "a".repeat(64),
  };
  const first = await client.idempotencyKey.create({ data });
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({ data }),
  );
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

it("checks normalized identities, nonempty labels, valid roles and idempotency outcomes", async ({
  fixture,
}) => {
  const { client, userA, companyA } = fixture;
  await expectRejectedWrite(client, () =>
    client.user.create({ data: { email: "MixedCase@example.test" } }),
  );
  await expectRejectedWrite(client, () =>
    client.company.update({ where: { id: companyA }, data: { name: " " } }),
  );
  await expectRejectedWrite(
    client,
    () =>
      client.$executeRaw`UPDATE memberships SET role = 'admin' WHERE company_id = ${companyA}::uuid`,
  );
  const data = {
    companyId: companyA,
    createdBy: userA,
    key: "invalid-outcome",
    requestHash: "a".repeat(64),
  };
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({ data: { ...data, state: "completed" } }),
  );
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({ data: { ...data, responseStatus: 200 } }),
  );
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({ data: { ...data, requestHash: "invalid" } }),
  );
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({ data: { ...data, key: " " } }),
  );
  await expectRejectedWrite(client, () =>
    client.idempotencyKey.create({
      data: {
        ...data,
        state: "completed",
        responseStatus: 999,
        responseBody: {},
      },
    }),
  );
});

for (const role of [
  "owner",
  "manager",
  "accountant",
  "employee",
  "subcontractor",
] as const) {
  it(`supports company role ${role}`, async ({ fixture }) => {
    const { client, userA, companyA } = fixture;
    const user = await client.user.create({
      data: { email: "additional-synthetic@example.test" },
    });
    const member = await client.membership.create({
      data: { companyId: companyA, userId: user.id, createdBy: userA, role },
    });
    expect(member.role).toBe(role);
  });
}

for (const role of [
  "employee",
  "subcontractor",
  "manager",
  "accountant",
] as const) {
  it(`refuses self-created non-owner bootstrap role ${role}`, async ({
    fixture,
  }) => {
    const { client } = fixture;
    const factory = syntheticFactory(1202);
    const person = await client.user.create({ data: factory.user() });
    const company = await client.company.create({
      data: factory.company(person.id),
    });
    await expectRejectedWrite(
      client,
      () =>
        client.membership.create({
          data: { ...factory.membership(company.id, person.id), role },
        }),
      "bootstrap owner",
    );
  });
}

it("refuses inactive or additional self-created owners", async ({
  fixture,
}) => {
  const { client, companyA } = fixture;
  const factory = syntheticFactory(1203);
  const person = await client.user.create({ data: factory.user() });
  const company = await client.company.create({
    data: factory.company(person.id),
  });
  await expectRejectedWrite(
    client,
    () =>
      client.membership.create({
        data: { ...factory.membership(company.id, person.id), isActive: false },
      }),
    "bootstrap owner",
  );
  await expectRejectedWrite(
    client,
    () =>
      client.membership.create({
        data: factory.membership(companyA, person.id),
      }),
    "bootstrap owner",
  );
});
