import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";

export type NumberKind = "job" | "invoice" | "credit_note" | "quote";

/**
 * Next per-company number for `kind`, atomically: the counter row stays
 * locked until the calling transaction ends, so concurrent creates/issues
 * never share a number, and a rolled-back one leaves no gap.
 */
export async function nextNumber(
  tx: Prisma.TransactionClient,
  companyId: string,
  kind: NumberKind,
): Promise<number> {
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO number_sequences (company_id, kind, last_value)
    VALUES (${companyId}::uuid, ${kind}, 1)
    ON CONFLICT (company_id, kind)
    DO UPDATE SET last_value = number_sequences.last_value + 1
    RETURNING last_value`;
  const value = rows[0]?.last_value;
  if (!value) throw new Error("Numbering failed");
  return value;
}
