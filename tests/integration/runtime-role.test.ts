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
