import { expect, it } from "vitest";
import { withTestDatabase } from "../helpers/database";
import { syntheticFactory } from "../helpers/factories";

const user = syntheticFactory(1101).user();
it("rolls back successful tests, including inserts into immutable audit history", async () => {
  await withTestDatabase(async (database) => {
    const factory = syntheticFactory(1101);
    const person = await database.user.create({ data: factory.user() });
    const company = await database.company.create({
      data: factory.company(person.id),
    });
    await database.membership.create({
      data: factory.membership(company.id, person.id),
    });
    await database.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await database.auditEvent.create({
      data: {
        companyId: company.id,
        createdBy: person.id,
        action: "synthetic.created",
        targetType: "company",
        targetId: company.id,
      },
    });
    expect(
      await database.auditEvent.count({ where: { companyId: company.id } }),
    ).toBe(1);
  });
  await withTestDatabase(async (database) => {
    expect(
      await database.user.findUnique({ where: { id: user.id } }),
    ).toBeNull();
    expect(
      await database.auditEvent.count({ where: { createdBy: user.id } }),
    ).toBe(0);
  });
});

it("rolls back assertion failures and retains the original failure", async () => {
  const failure = new Error("synthetic assertion failure");
  await expect(
    withTestDatabase(async (database) => {
      await database.user.create({ data: user });
      throw failure;
    }),
  ).rejects.toBe(failure);
  await withTestDatabase(async (database) => {
    expect(await database.user.count({ where: { id: user.id } })).toBe(0);
  });
});

it("rolls back failed SQL without leaking a partially inserted record", async () => {
  await expect(
    withTestDatabase(async (database) => {
      await database.user.create({ data: user });
      await database.user.create({ data: user });
    }),
  ).rejects.toThrow();
  await withTestDatabase(async (database) => {
    expect(await database.user.count({ where: { id: user.id } })).toBe(0);
  });
});

it("supports parallel tests with different deterministic factory namespaces", async () => {
  await Promise.all(
    [1102, 1103].map((seed) =>
      withTestDatabase(async (database) => {
        const person = syntheticFactory(seed).user();
        await database.user.create({ data: person });
        expect(await database.user.count({ where: { id: person.id } })).toBe(1);
      }),
    ),
  );
  await withTestDatabase(async (database) => {
    expect(
      await database.user.count({
        where: {
          id: {
            in: [1102, 1103].map((seed) => syntheticFactory(seed).user().id),
          },
        },
      }),
    ).toBe(0);
  });
});
