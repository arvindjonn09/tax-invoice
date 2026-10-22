import { afterAll, expect, it } from "vitest";
import { connectIsolatedDatabase, withRollback } from "../support/database";
import { createFactories } from "../support/factories";

const client = connectIsolatedDatabase();
afterAll(() => client.$disconnect());
const factories = createFactories("test-support");

it("builds a valid demo company with a bootstrap owner", async () => {
  const { company, owner, ownerMembership } =
    await factories.companyWithOwner(client);
  expect(company.isDemo).toBe(true);
  expect(company.createdBy).toBe(owner.id);
  expect(owner.email).toMatch(/^test-support-user-\d+@example\.test$/);
  expect(ownerMembership).toMatchObject({
    companyId: company.id,
    userId: owner.id,
    createdBy: owner.id,
    role: "owner",
    isActive: true,
  });
});

it("adds members created by an existing member", async () => {
  const { company, owner } = await factories.companyWithOwner(client, {
    isDemo: false,
  });
  const { membership } = await factories.member(client, {
    companyId: company.id,
    createdBy: owner.id,
    role: "employee",
  });
  expect(company.isDemo).toBe(false);
  expect(membership).toMatchObject({ role: "employee", createdBy: owner.id });
});

it("rolls back everything a test writes", async () => {
  const before = await client.company.count();
  const created = await withRollback(client, async (tx) => {
    const { company } = await factories.companyWithOwner(tx);
    expect(await tx.company.count()).toBe(before + 1);
    return company.id;
  });
  expect(
    await client.company.findUnique({ where: { id: created } }),
  ).toBeNull();
  expect(await client.company.count()).toBe(before);
});

it("still enforces deferred constraints inside a rolled-back test", async () => {
  // A company without its owner membership violates the deferred creator FK.
  await expect(
    withRollback(client, async (tx) => {
      const lone = await factories.user(tx);
      await tx.company.create({
        data: { name: "Sample orphan company", createdBy: lone.id },
      });
    }),
  ).rejects.toThrow();
});
