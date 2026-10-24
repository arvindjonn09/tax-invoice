import { readFile } from "node:fs/promises";
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

async function catalogNames() {
  const rows = await client.$queryRaw<{ name: string }[]>`
    SELECT conname AS name FROM pg_constraint
    JOIN pg_namespace n ON n.oid = connamespace WHERE n.nspname = 'public'
    UNION
    SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'`;
  return new Set(rows.map((row) => row.name));
}

// #124: Prisma must name constraints exactly as the applied migrations did,
// or `prisma migrate diff` reports drift and a future `migrate dev` would
// generate spurious renames.
it("maps every explicitly named constraint and index to an applied object", async () => {
  const schema = await readFile(
    new URL("../../packages/database/prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const mapped = [...schema.matchAll(/\bmap: "([a-z0-9_]+)"/g)].map(
    (match) => match[1]!,
  );
  expect(mapped).toEqual(
    expect.arrayContaining([
      "user_invitations_creator_fkey",
      "contractor_acceptances_company_id_offer_id_job_id_contractor_id",
    ]),
  );
  const names = await catalogNames();
  expect(mapped.filter((name) => !names.has(name))).toEqual([]);
});

it("keeps names PostgreSQL truncated at its 63-byte identifier limit", async () => {
  const names = await catalogNames();
  expect(
    names.has(
      "contractor_acceptances_company_id_offer_id_job_id_contractor_id",
    ),
  ).toBe(true);
  expect(
    names.has(
      "contractor_acceptances_company_id_offer_id_job_id_contractor_id_key",
    ),
  ).toBe(false);
  expect(names.has("user_invitations_company_id_created_by_fkey")).toBe(false);
});
