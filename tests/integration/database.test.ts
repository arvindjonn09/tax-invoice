import { afterAll, expect, it } from "vitest";
import { createDatabaseClient } from "../../packages/database/src/index";

const databaseName = process.env.JOBFLOW_ISOLATED_TEST_DATABASE;
if (!databaseName || !/^jobflow_test_[a-f0-9]{32}$/.test(databaseName)) {
  throw new Error(
    "Run integration tests through pnpm test:integration for an isolated database",
  );
}
const connection = process.env.DATABASE_URL;
if (!connection) throw new Error("Missing isolated connection");
const client = createDatabaseClient(connection);
afterAll(() => client.$disconnect());

it("connects through Prisma only to this run's migrated database", async () => {
  const rows = await client.$queryRaw<
    { name: string }[]
  >`SELECT current_database() AS name`;
  expect(rows).toEqual([{ name: databaseName }]);
  const history = await client.$queryRaw<
    { migration_name: string; finished: boolean }[]
  >`SELECT migration_name, finished_at IS NOT NULL AS finished FROM "_prisma_migrations" ORDER BY migration_name`;
  expect(history).toEqual([
    { migration_name: "20261022000000_bootstrap", finished: true },
    { migration_name: "20261023000000_core_tenancy", finished: true },
    { migration_name: "20261023010000_auth", finished: true },
    { migration_name: "20261023020000_company_gst", finished: true },
    { migration_name: "20261023040000_employees", finished: true },
    { migration_name: "20261023050000_customers", finished: true },
    { migration_name: "20261023060000_jobs", finished: true },
  ]);
});

it("rolls back failed transactions without leaving test data", async () => {
  await client.$executeRaw`CREATE TABLE integration_probe (id INTEGER PRIMARY KEY)`;
  try {
    await expect(
      client.$transaction(async (transaction) => {
        await transaction.$executeRaw`INSERT INTO integration_probe (id) VALUES (1)`;
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");
    expect(await client.$queryRaw`SELECT * FROM integration_probe`).toEqual([]);
  } finally {
    await client.$executeRaw`DROP TABLE integration_probe`;
  }
});
