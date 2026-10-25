import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { lockRow } from "../db/locks";
import type { ObjectStore } from "./store";

/**
 * Unattached uploads (#137). A document that was uploaded but never attached
 * to an expense, bill, work evidence or anything else (an abandoned form, a
 * failed attach) isn't a business record: nothing in the books points to it.
 * After the grace period it is deleted, object first, with an audit event.
 * Attached documents are never touched: every table that references
 * `documents` is read from the database catalog, so a new one is covered
 * without changing this code, and the foreign keys refuse the delete anyway.
 */
export const UNATTACHED_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type Reference = { tbl: string; col: string };

/** Every (table, document column) whose foreign key references documents. */
export async function documentReferences(
  db: PrismaClient,
): Promise<Reference[]> {
  return db.$queryRaw<Reference[]>`
    SELECT c.conrelid::regclass::text AS tbl, quote_ident(a.attname) AS col
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child, parent)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child
    JOIN pg_attribute p ON p.attrelid = c.confrelid AND p.attnum = k.parent
    WHERE c.contype = 'f' AND c.confrelid = 'documents'::regclass AND p.attname = 'id'
    ORDER BY 1, 2`;
}

/**
 * SQL that is true when document `d` is referenced anywhere, or was ever
 * part of a record: an audit event other than its own upload names it (for
 * example a receipt swapped out of a submitted expense, kept as evidence of
 * what was submitted).
 */
function attachedSql(references: Reference[]): string {
  return [
    ...references.map(
      // Identifiers come from the catalog, already quoted by PostgreSQL.
      ({ tbl, col }) =>
        `EXISTS (SELECT 1 FROM ${tbl} r WHERE r.${col} = d.id AND r.company_id = d.company_id)`,
    ),
    `EXISTS (SELECT 1 FROM audit_events e WHERE e.company_id = d.company_id
       AND e.action <> 'document.uploaded' AND e.target_id <> d.id::text
       AND strpos(e.metadata::text, d.id::text) > 0)`,
  ].join(" OR ");
}

export type CleanupResult = {
  /** Documents deleted (or that would be, with dryRun). */
  deleted: { id: string; companyId: string; kind: string; sizeBytes: number }[];
  /** Candidates skipped because they were attached or changed meanwhile. */
  skipped: number;
  /** Candidates that failed (left for the next run; never half-deleted). */
  failed: number;
};

export async function cleanUnattachedDocuments(
  db: PrismaClient,
  store: ObjectStore,
  {
    now = new Date(),
    graceDays = UNATTACHED_GRACE_DAYS,
    dryRun = false,
    limit = 500,
  }: { now?: Date; graceDays?: number; dryRun?: boolean; limit?: number } = {},
): Promise<CleanupResult> {
  if (!Number.isInteger(graceDays) || graceDays < 1)
    throw new RangeError("The grace period is at least one day");
  const references = await documentReferences(db);
  // Expenses, work evidence, supplier bills and invoice PDFs at least: an
  // empty or short list means the catalog lookup is wrong, so stop.
  if (references.length < 4)
    throw new Error("Document references not found; refusing to clean up");
  const attached = attachedSql(references);
  const cutoff = new Date(now.getTime() - graceDays * DAY_MS);
  const candidates = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT d.id FROM documents d
     WHERE d.created_at < $1 AND NOT (${attached})
     ORDER BY d.created_at, d.id LIMIT $2`,
    cutoff,
    limit,
  );
  const result: CleanupResult = { deleted: [], skipped: 0, failed: 0 };
  for (const { id } of candidates) {
    let done: CleanupResult["deleted"][number] | null;
    try {
      done = await deleteOne(id);
    } catch {
      // One storage or database error doesn't stop the batch; the row is
      // still there (rolled back), so the next run retries it.
      result.failed += 1;
      continue;
    }
    if (done) result.deleted.push(done);
    else result.skipped += 1;
  }
  return result;

  async function deleteOne(id: string) {
    return db.$transaction(
      async (tx) => {
        // FOR UPDATE: the same lock bills and expenses take to attach, and it
        // conflicts with the KEY SHARE lock any new referencing row takes, so
        // nothing can attach this document until we commit.
        await lockRow(tx, "documents", id);
        const [row] = await tx.$queryRawUnsafe<
          {
            id: string;
            company_id: string;
            kind: string;
            size_bytes: number;
            object_key: string;
            created_by: string;
            created_at: Date;
          }[]
        >(
          `SELECT d.id, d.company_id, d.kind::text AS kind, d.size_bytes, d.object_key, d.created_by, d.created_at
         FROM documents d WHERE d.id = $1::uuid AND d.created_at < $2 AND NOT (${attached})`,
          id,
          cutoff,
        );
        if (!row) return null;
        const summary = {
          id: row.id,
          companyId: row.company_id,
          kind: row.kind,
          sizeBytes: row.size_bytes,
        };
        if (dryRun) return summary;
        // Object first: if the row delete then failed, a retry finds the row
        // again (deleting a missing object is a no-op); the reverse order
        // could leave an unreachable private file behind.
        await store.delete(row.object_key);
        await tx.document.delete({ where: { id: row.id } });
        await tx.auditEvent.create({
          data: {
            companyId: row.company_id,
            createdBy: row.created_by,
            action: "document.unattached_deleted",
            targetType: "document",
            targetId: row.id,
            metadata: {
              kind: row.kind,
              sizeBytes: row.size_bytes,
              uploadedAt: row.created_at.toISOString(),
              graceDays,
              by: "unattached-document-cleanup",
            },
          },
        });
        return summary;
      },
      // Room for the storage delete inside the transaction.
      { timeout: 30_000 },
    );
  }
}
