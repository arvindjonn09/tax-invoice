import {
  Prisma,
  type PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import type { PolicyHandler } from "../authz/policy";
import { clientIp, throttle } from "../http/throttle";

// #62 full company data export. Every table with a company_id column is found
// from the catalog, so records added by later migrations are exported without
// a code change. Values keep their exact form: bigint cents and numerics as
// strings, timestamps as ISO instants and dates as YYYY-MM-DD, with each
// column's database type in the manifest so the file can be read back
// losslessly (decodeCompanyExport). Secrets and internal keys are left out.

export const EXPORT_FORMAT = "jobflow.company-export";
export const EXPORT_VERSION = 1;

/** Internal state or secrets, never exported. */
const EXCLUDED_TABLES = new Set(["idempotency_keys", "_prisma_migrations"]);
const EXCLUDED_COLUMNS = new Set([
  "user_invitations.token_hash",
  "documents.object_key",
]);
const isExcluded = (table: string, column: string) =>
  EXCLUDED_COLUMNS.has(`${table}.${column}`) || column === "request_hash";

type Tx = Prisma.TransactionClient;
type Column = { name: string; type: string };
type Value =
  string | number | boolean | null | Value[] | { [k: string]: Value };
export type CompanyExport = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  companyId: string;
  exportedAt: string;
  tables: Record<string, { columns: Column[]; rows: Record<string, Value>[] }>;
};

function encode(value: unknown, type: string): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date)
    return type === "date"
      ? value.toISOString().slice(0, 10)
      : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => encode(item, ""));
  return value as Value;
}

/** Decode one exported value back to what the database returned. */
export function decodeValue(value: Value, type: string): unknown {
  if (value === null) return null;
  if (type === "bigint") return BigInt(value as string);
  if (type === "numeric") return new Prisma.Decimal(value as string);
  if (type === "date") return new Date(`${value as string}T00:00:00.000Z`);
  if (type.startsWith("timestamp")) return new Date(value as string);
  return value;
}

async function companyTables(tx: Tx) {
  const columns = await tx.$queryRaw<
    { table_name: string; column_name: string; data_type: string }[]
  >`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.table_name IN (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'company_id')
    ORDER BY c.table_name, c.ordinal_position`;
  const tables = new Map<string, Column[]>();
  for (const c of columns) {
    if (EXCLUDED_TABLES.has(c.table_name)) continue;
    if (isExcluded(c.table_name, c.column_name)) continue;
    const list = tables.get(c.table_name) ?? [];
    list.push({ name: c.column_name, type: c.data_type });
    tables.set(c.table_name, list);
  }
  return tables;
}

/**
 * Every record of one company. Run inside a repeatable-read transaction so
 * all tables share one snapshot.
 */
export async function exportCompany(
  tx: Tx,
  companyId: string,
  exportedAt = new Date(),
): Promise<CompanyExport> {
  const tables: CompanyExport["tables"] = {};
  for (const [table, columns] of await companyTables(tx)) {
    // Identifiers come from the catalog, never from input; values are bound.
    const list = columns.map((c) => `"${c.name}"`).join(", ");
    const order = columns.some((c) => c.name === "id") ? ' ORDER BY "id"' : "";
    const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${list} FROM "${table}" WHERE "company_id" = $1::uuid${order}`,
      companyId,
    );
    tables[table] = {
      columns,
      rows: rows.map((row) =>
        Object.fromEntries(
          columns.map((c) => [c.name, encode(row[c.name], c.type)]),
        ),
      ),
    };
  }
  // The company row itself and its members' identities (never credentials).
  const company = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM companies WHERE id = ${companyId}::uuid`;
  const members = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT u.id, u.email, u.name, u.created_at FROM users u
    WHERE u.id IN (SELECT user_id FROM memberships WHERE company_id = ${companyId}::uuid)
    ORDER BY u.id`;
  const plain = (rows: Record<string, unknown>[], types: Column[]) => ({
    columns: types,
    rows: rows.map((row) =>
      Object.fromEntries(
        types.map((c) => [c.name, encode(row[c.name], c.type)]),
      ),
    ),
  });
  const companyColumns = await tx.$queryRaw<Column[]>`
    SELECT column_name AS name, data_type AS type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'companies' ORDER BY ordinal_position`;
  tables.companies = plain(company, companyColumns);
  tables.users = plain(members, [
    { name: "id", type: "uuid" },
    { name: "email", type: "text" },
    { name: "name", type: "text" },
    { name: "created_at", type: "timestamp with time zone" },
  ]);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    companyId,
    exportedAt: exportedAt.toISOString(),
    tables: Object.fromEntries(
      Object.entries(tables).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

/** Parse an export file back into typed rows (bigint, Decimal, Date). */
export function decodeCompanyExport(text: string) {
  const data = JSON.parse(text) as CompanyExport;
  if (data.format !== EXPORT_FORMAT || data.version !== EXPORT_VERSION)
    throw new Error("Not a JobFlow company export");
  return Object.fromEntries(
    Object.entries(data.tables).map(([table, { columns, rows }]) => [
      table,
      rows.map((row) =>
        Object.fromEntries(
          columns.map((c) => [
            c.name,
            decodeValue(row[c.name] ?? null, c.type),
          ]),
        ),
      ),
    ]),
  );
}

/**
 * Download the whole company as one JSON file (owner, accountant: export.run).
 * Throttled and audited; never cached.
 */
export function companyExportHandler(
  db: () => PrismaClient,
): PolicyHandler<unknown> {
  return async ({ actor, request }) => {
    await throttle(db(), "export", {
      userId: actor.userId,
      ip: clientIp(request.headers),
    });
    const data = await db().$transaction(
      (tx) => exportCompany(tx, actor.companyId),
      { isolationLevel: "RepeatableRead", timeout: 60_000 },
    );
    const rows = Object.values(data.tables).reduce(
      (total, table) => total + table.rows.length,
      0,
    );
    await withAudit(db(), (_tx, audit) =>
      audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "company.exported",
        target: { type: "company", id: actor.companyId },
        after: { tables: Object.keys(data.tables).length, rows },
      }),
    );
    return new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="jobflow-export-${data.exportedAt.slice(0, 10)}.json"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  };
}
