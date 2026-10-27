import type { Prisma } from "../../../../../packages/database/src/generated/prisma/client";
import { lockRow } from "../db/locks";

/**
 * Lock an uploaded document in this company and read what it's attached to.
 * Bills and expenses both claim purchase documents through this, so the two
 * paths serialise on the same row and recheck every attachment under the
 * lock; their separate unique indexes alone can't stop one document backing
 * a bill and an expense at once.
 */
export async function lockDocumentClaim(
  tx: Prisma.TransactionClient,
  companyId: string,
  documentId: string,
) {
  await lockRow(tx, "documents", documentId, companyId);
  return tx.document.findFirst({
    where: { id: documentId, companyId },
    include: {
      expense: { select: { id: true } },
      supplierBill: { select: { id: true } },
      supplierCredit: { select: { id: true } },
      workEvidence: { select: { id: true } },
      billSubmission: { select: { id: true, status: true } },
    },
  });
}
