import {
  Prisma,
  type PrismaClient,
} from "../../../../../packages/database/src/generated/prisma/client";

/** Tables whose rows are updated through audited handlers. */
const LOCKABLE = new Set([
  "employees",
  "customers",
  "customer_contacts",
  "locations",
  "jobs",
  "job_visits",
  "assignments",
  "contractors",
  "contractor_offers",
  "timesheets",
  "expenses",
  "company_gst_registrations",
  "invoices",
  "quotes",
  "customer_receipts",
  "supplier_bills",
  "supplier_payments",
  "supplier_credits",
  "subcontractor_bill_submissions",
  "documents",
]);

export type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Lock one row until the transaction ends, so the "before" snapshot an audit
 * event records is the value this update really replaced, never a stale read
 * from before a concurrent change committed. Pass `companyId` when `id` came
 * from the request, so another company's row is never locked (#53).
 */
export async function lockRow(
  tx: Tx,
  table: string,
  id: string,
  companyId?: string,
) {
  if (!LOCKABLE.has(table)) throw new Error(`Not lockable: ${table}`);
  // The table name comes from the allowlist above, never from input.
  await (companyId
    ? tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`
    : tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`);
}

/** A unique-constraint violation, optionally on a named index/constraint. */
export function isUniqueViolation(error: unknown, name?: string): boolean {
  const text = `${String(error)} ${JSON.stringify(error ?? null)}`;
  return /P2002|23505/.test(text) && (!name || text.includes(name));
}
