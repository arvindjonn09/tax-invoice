import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("reverses tenancy DDL on an empty disposable database and reapplies it", async () => {
  const base = new URL(process.env.TEST_DATABASE_URL ?? "");
  base.pathname = "/jobflow_test";
  const source = `
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { withIsolatedDatabase } from './scripts/database/test-runner.mjs';
const { Client } = createRequire(new URL('./packages/database/package.json', import.meta.url))('pg');
await withIsolatedDatabase(async env => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const check = async present => {
      const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('companies','users','memberships','audit_events','idempotency_keys')");
      if (rows.length !== (present ? 5 : 0)) throw new Error('Unexpected tenancy tables');
    };
    await check(true);
    await client.query(await readFile('packages/database/prisma/rollbacks/20261023000000_core_tenancy.sql', 'utf8'));
    await check(false);
    await client.query(await readFile('packages/database/prisma/migrations/20261023000000_core_tenancy/migration.sql', 'utf8'));
    await check(true);
    const { rows } = await client.query("SELECT tgname FROM pg_trigger WHERE tgname = 'audit_events_append_only'");
    if (rows.length !== 1) throw new Error('Missing audit guard');
    console.log('tenancy forward/down/forward passed');
  } finally { await client.end(); }
});`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env: { ...process.env, TEST_DATABASE_URL: base.toString() } },
  );
  expect(stdout).toContain("tenancy forward/down/forward passed");
}, 30000);
