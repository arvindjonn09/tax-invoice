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
  "company_gst_registrations",
]);

export type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Lock one row until the transaction ends, so the "before" snapshot an audit
 * event records is the value this update really replaced, never a stale read
 * from before a concurrent change committed.
 */
export async function lockRow(tx: Tx, table: string, id: string) {
  if (!LOCKABLE.has(table)) throw new Error(`Not lockable: ${table}`);
  // The table name comes from the allowlist above, never from input.
  await tx.$queryRaw`SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id}::uuid FOR UPDATE`;
}

/** A unique-constraint violation, optionally on a named index/constraint. */
export function isUniqueViolation(error: unknown, name?: string): boolean {
  const text = `${String(error)} ${JSON.stringify(error ?? null)}`;
  return /P2002|23505/.test(text) && (!name || text.includes(name));
}
