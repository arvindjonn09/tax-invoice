import { randomUUID } from "node:crypto";
import { sydneyToday } from "../../apps/web/src/server/company/gst";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type CommittedDatabase,
  withCommittedDatabase,
} from "../helpers/committed-database";
import { syntheticFactory } from "../helpers/factories";

// #71 follow-up from #12: the append-only audit trigger only stops ordinary
// DML. Prove the production runtime role (packages/database/prisma/roles/
// runtime-role.sql) cannot bypass it: no UPDATE/DELETE/TRUNCATE, no trigger
// disable/drop, no replication-role switch, no DDL.
type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  on(event: "error", listener: () => void): void;
  query(sql: string): Promise<{ rows: unknown[] }>;
};
const { Client } = createRequire(
  new URL("../../packages/database/package.json", import.meta.url),
)("pg") as {
  Client: new (options: { connectionString: string }) => PgClient;
};

let database: CommittedDatabase;
let client: PgClient;
let companyId: string, userId: string, customerId: string;
const factory = syntheticFactory(0x7171);

beforeAll(async () => {
  database = await withCommittedDatabase();
  client = new Client({ connectionString: database.url });
  client.on("error", () => {});
  await client.connect();
  await client.query(
    await readFile(
      new URL(
        "../../packages/database/prisma/roles/runtime-role.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // Seed one audit event as the owner so there is a row to attack.
  const user = factory.user();
  const company = factory.company(user.id);
  await database.client.user.create({ data: user });
  await database.client.$transaction(async (tx) => {
    await tx.company.create({ data: company });
    await tx.membership.create({
      data: factory.membership(company.id, user.id),
    });
  });
  companyId = company.id;
  userId = user.id;
  const customer = await database.client.customer.create({
    data: { companyId, name: "Synthetic runtime customer", createdBy: userId },
  });
  customerId = customer.id;
  await database.client.auditEvent.create({
    data: {
      companyId: company.id,
      createdBy: user.id,
      action: "company.created",
      targetType: "company",
      targetId: company.id,
    },
  });
}, 60_000);

afterAll(async () => {
  await client?.end();
  await database?.release();
});

/** Run `sql` as jobflow_app in its own transaction; return the SQLSTATE or "ok". */
async function asRuntime(sql: string): Promise<string> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL ROLE jobflow_app");
    await client.query(sql);
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await client.query("ROLLBACK");
  }
}

describe("runtime database role", () => {
  it("can read and write ordinary rows and append audit events", async () => {
    expect(await asRuntime("SELECT count(*) FROM companies")).toBe("ok");
    expect(
      await asRuntime(
        "INSERT INTO audit_events (company_id, created_by, action, target_type, target_id) SELECT company_id, created_by, 'test.appended', target_type, target_id FROM audit_events LIMIT 1",
      ),
    ).toBe("ok");
    expect(await asRuntime("UPDATE companies SET name = name")).toBe("ok");
  });

  it.each([
    ["UPDATE", "UPDATE audit_events SET action = 'tampered'"],
    ["DELETE", "DELETE FROM audit_events"],
    ["TRUNCATE", "TRUNCATE audit_events"],
    ["disable trigger", "ALTER TABLE audit_events DISABLE TRIGGER ALL"],
    ["drop trigger", "DROP TRIGGER audit_events_append_only ON audit_events"],
    ["drop function", "DROP FUNCTION jobflow_reject_audit_mutation() CASCADE"],
    ["replication role", "SET session_replication_role = replica"],
    ["create table", "CREATE TABLE runtime_scratch (id int)"],
    ["drop table", "DROP TABLE audit_events"],
    ["migration history", "SELECT * FROM _prisma_migrations"],
  ])("refuses %s on the audit log", async (_, sql) => {
    // 42501 insufficient_privilege (or 42809/55000 if a layer below answers).
    expect(await asRuntime(sql)).toMatch(/^(42501|42809|55000)$/);
  });

  it("leaves the audit row intact", async () => {
    const { rows } = await client.query(
      "SELECT action FROM audit_events WHERE action = 'company.created'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe("GST posting privileges (#166)", () => {
  it("refuses forged posting rows and direct calls to the posting helper", async () => {
    const id = randomUUID();
    expect(
      await asRuntime(`INSERT INTO gst_source_postings(company_id,source_id,original_on,effective_on)
      VALUES('${companyId}','${id}','2026-01-01','2026-01-01')`),
    ).toBe("42501");
    expect(
      await asRuntime(
        `SELECT jobflow_record_gst_posting('${companyId}'::uuid,'${id}'::uuid,'2026-01-01'::date)`,
      ),
    ).toBe("42501");
    expect(
      await database.client
        .$queryRaw`SELECT * FROM gst_source_postings WHERE source_id=${id}::uuid`,
    ).toEqual([]);
  });

  it.each([
    "jobflow_guard_report_source",
    "jobflow_supplier_credit_posting",
    "jobflow_expense_payment_posting",
  ])("cannot attach privileged %s to an attacker-owned table", async (fn) => {
    expect(
      await asRuntime(`CREATE TEMP TABLE forged_source(id uuid);
      CREATE TRIGGER forged BEFORE INSERT ON forged_source FOR EACH ROW EXECUTE FUNCTION ${fn}()`),
    ).toBe("42501");
  });

  it("keeps append-only financial grants narrow after rerunning deployment grants", async () => {
    const rows = await database.client.$queryRaw<
      { table_name: string; privilege_type: string }[]
    >`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee='jobflow_app' AND table_schema='public'
        AND table_name IN ('gst_source_postings','gst_periods','gst_report_revisions','gst_manual_adjustments',
          'credit_cash_adjustments','receipt_allocations','receipt_gst_adjustments','supplier_bill_items',
          'supplier_payment_allocations','supplier_payment_gst_adjustments','invoice_pdfs',
          'supplier_credit_items','supplier_credit_gst_adjustments','supplier_payment_expense_allocations',
          'supplier_payment_expense_gst_adjustments','employee_rate_history','contractor_acceptances',
          'work_evidence','job_status_events','subcontractor_bill_submission_items')
        AND (privilege_type IN ('UPDATE','DELETE','TRUNCATE') OR (table_name='gst_source_postings' AND privilege_type='INSERT'))`;
    expect(rows).toEqual([]);
  });

  it("runtime source writes still create immutable postings on the correct open day", async () => {
    const id = randomUUID();
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO gst_periods(company_id,starts_on,ends_on,created_by)
        VALUES('${companyId}','2026-01-01','2026-01-31','${userId}')`);
      await client.query("SET LOCAL ROLE jobflow_app");
      // A temporary lookalike must not intercept the definer's posting write.
      await client.query(
        "CREATE TEMP TABLE gst_source_postings(company_id uuid,source_id uuid,original_on date,effective_on date)",
      );
      await client.query(`INSERT INTO public.customer_receipts
        (id,company_id,customer_id,received_on,amount_cents,method,idempotency_key,request_hash,created_by)
        VALUES('${id}','${companyId}','${customerId}','2026-01-15',1100,'card','${id}','${"a".repeat(64)}','${userId}')`);
      const { rows } = await client.query(
        `SELECT original_on::text,effective_on::text FROM public.gst_source_postings WHERE source_id='${id}'`,
      );
      expect(rows).toEqual([
        { original_on: "2026-01-15", effective_on: sydneyToday() },
      ]);
      expect(
        (await client.query("SELECT * FROM pg_temp.gst_source_postings")).rows,
      ).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("refuses a source write when both its original period and today are locked", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO gst_periods(company_id,starts_on,ends_on,created_by)
        VALUES('${companyId}','2026-01-01','${sydneyToday()}','${userId}')`);
      await client.query("SET LOCAL ROLE jobflow_app");
      const id = randomUUID();
      await expect(
        client.query(`INSERT INTO customer_receipts
        (id,company_id,customer_id,received_on,amount_cents,method,idempotency_key,request_hash,created_by)
        VALUES('${id}','${companyId}','${customerId}','2026-01-15',1100,'card','${id}','${"a".repeat(64)}','${userId}')`),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
