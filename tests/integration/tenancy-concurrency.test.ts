import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("one concurrent idempotency insert wins in its own per-test committed database", async () => {
  const base = new URL(process.env.TEST_DATABASE_URL ?? "");
  base.pathname = "/jobflow_test";
  const source = `
import { createRequire } from 'node:module';
import { withIsolatedDatabase } from './scripts/database/test-runner.mjs';
const { Pool } = createRequire(new URL('./packages/database/package.json', import.meta.url))('pg');
await withIsolatedDatabase(async env => {
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const user = '00000011-0000-4000-8000-000000000001';
  const company = '00000011-0000-4000-8000-000000000002';
  const setup = await pool.connect();
  try {
    await setup.query('BEGIN');
    await setup.query('INSERT INTO users(id,email) VALUES ($1,$2)', [user, 'synthetic-concurrency@example.test']);
    await setup.query('INSERT INTO companies(id,name,created_by) VALUES ($1,$2,$3)', [company, 'Synthetic concurrency company', user]);
    await setup.query("INSERT INTO memberships(company_id,user_id,created_by,role) VALUES ($1,$2,$2,'owner')", [company,user]);
    await setup.query('COMMIT');
  } finally { setup.release(); }
  try {
    const insert = () => pool.query('INSERT INTO idempotency_keys(company_id,created_by,key,request_hash) VALUES ($1,$2,$3,$4)', [company,user,'synthetic-key','a'.repeat(64)]);
    const results = await Promise.allSettled([insert(), insert()]);
    if (results.filter(r => r.status === 'fulfilled').length !== 1) throw new Error('Expected one winner');
    const rejected = results.find(r => r.status === 'rejected');
    if (rejected?.reason?.code !== '23505') throw new Error('Expected unique constraint rejection');
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM idempotency_keys');
    if (rows[0].count !== 1) throw new Error('Expected one stored record');
    console.log('one committed winner; duplicate rejected');
  } finally { await pool.end(); }
});`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env: { ...process.env, TEST_DATABASE_URL: base.toString() } },
  );
  expect(stdout).toContain("one committed winner; duplicate rejected");
}, 30000);
