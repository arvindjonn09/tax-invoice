import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("reverses tenancy, auth, company GST, employee, customer, job and assignment DDL (newest first) on an empty disposable database and reapplies it", async () => {
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
    const checkAuth = async present => {
      const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('auth_sessions','auth_accounts','auth_verifications','auth_rate_limits')");
      if (rows.length !== (present ? 4 : 0)) throw new Error('Unexpected auth tables');
    };
    const run = file => readFile('packages/database/prisma/' + file, 'utf8').then(sql => client.query(sql));
    await check(true);
    await checkAuth(true);
    // Roll back newest first: later migrations depend on users/companies.
    await run('rollbacks/20261024090000_bill_evidence.sql');
    await run('rollbacks/20261023210000_reporting_periods.sql');
    await run('rollbacks/20261023200000_invoice_pdfs.sql');
    await run('rollbacks/20261023190000_quotes.sql');
    await run('rollbacks/20261023180000_supplier_bills.sql');
    await run('rollbacks/20261023170000_receipts.sql');
    await run('rollbacks/20261023160000_invoices.sql');
    await run('rollbacks/20261023150000_work_evidence.sql');
    await run('rollbacks/20261023140000_timesheets.sql');
    await run('rollbacks/20261023130000_expenses.sql');
    await run('rollbacks/20261023110000_contractors.sql');
    await run('rollbacks/20261023100000_customer_primary.sql');
    await run('rollbacks/20261023090000_documents.sql');
    await run('rollbacks/20261023080000_user_invitations.sql');
    await run('rollbacks/20261023070000_assignments.sql');
    await run('rollbacks/20261023060000_jobs.sql');
    await run('rollbacks/20261023050000_customers.sql');
    await run('rollbacks/20261023040000_employees.sql');
    await run('rollbacks/20261023020000_company_gst.sql');
    const { rows: gst } = await client.query("SELECT 1 FROM pg_tables WHERE tablename = 'company_gst_registrations'");
    if (gst.length !== 0) throw new Error('GST registrations not rolled back');
    await run('rollbacks/20261023010000_auth.sql');
    await checkAuth(false);
    await run('rollbacks/20261023000000_core_tenancy.sql');
    await check(false);
    await run('migrations/20261023000000_core_tenancy/migration.sql');
    await run('migrations/20261023010000_auth/migration.sql');
    await run('migrations/20261023020000_company_gst/migration.sql');
    await run('migrations/20261023040000_employees/migration.sql');
    await run('migrations/20261023050000_customers/migration.sql');
    await run('migrations/20261023060000_jobs/migration.sql');
    await run('migrations/20261023070000_assignments/migration.sql');
    await run('migrations/20261023080000_user_invitations/migration.sql');
    await run('migrations/20261023090000_documents/migration.sql');
    await run('migrations/20261023100000_customer_primary/migration.sql');
    await run('migrations/20261023110000_contractors/migration.sql');
    await run('migrations/20261023130000_expenses/migration.sql');
    await run('migrations/20261023140000_timesheets/migration.sql');
    await run('migrations/20261023150000_work_evidence/migration.sql');
    await run('migrations/20261023160000_invoices/migration.sql');
    await run('migrations/20261023170000_receipts/migration.sql');
    await run('migrations/20261023180000_supplier_bills/migration.sql');
    await run('migrations/20261023190000_quotes/migration.sql');
    await run('migrations/20261023200000_invoice_pdfs/migration.sql');
    await run('migrations/20261023210000_reporting_periods/migration.sql');
    await run('migrations/20261024090000_bill_evidence/migration.sql');
    await check(true);
    await checkAuth(true);
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
