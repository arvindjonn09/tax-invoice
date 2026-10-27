import { randomBytes } from "node:crypto";
import { type Actor, requireSameCompany } from "@jobflow/authz";
import type { PrismaClient } from "../../../../../packages/database/src/generated/prisma/client";
import { withAudit } from "../../../../../packages/database/src/index";
import { type PolicyHandler, privateJson } from "../authz/policy";
import { isUniqueViolation } from "../db/locks";
import {
  LINK_TTL_SECONDS,
  safeFileName,
  sha256Hex,
  signLink,
} from "../documents/files";
import type { ObjectStore } from "../documents/store";
import { clientIp, throttle } from "../http/throttle";
import { uuidOrNull } from "../http/fields";
import {
  PdfLimitError,
  PDF_RENDERER_VERSION,
  invoiceDocument,
  pdfInput,
  renderInvoicePdf,
} from "./pdf";

// #48. The PDF of an issued invoice or credit note is rendered from its frozen
// snapshot and stored privately (#34) once. Later requests reuse the stored
// document, so an issued document's PDF never changes.

export type PdfDeps = {
  db: () => PrismaClient;
  store: () => ObjectStore | null;
  secret: () => string;
};

type Stored = { documentId: string; sha256: string; rendererVersion: string };

class NotIssued extends Error {}
class StorageUnavailable extends Error {}

/** Find or create the stored PDF of an issued (or void) invoice. */
export async function ensureInvoicePdf(
  deps: PdfDeps,
  actor: Pick<Actor, "companyId" | "userId">,
  invoiceId: string,
): Promise<Stored> {
  const db = deps.db();
  const existing = await db.invoicePdf.findUnique({
    where: { companyId_invoiceId: { companyId: actor.companyId, invoiceId } },
  });
  if (existing) return existing;
  const row = await db.invoice.findFirst({
    where: { id: invoiceId, companyId: actor.companyId },
    include: { items: true },
  });
  if (!row || row.status === "draft") throw new NotIssued();
  const credits = row.creditsId
    ? await db.invoice.findUnique({
        where: { id: row.creditsId },
        select: { reference: true },
      })
    : null;
  const bytes = await renderInvoicePdf(
    invoiceDocument(pdfInput(row, credits?.reference ?? null)),
  );
  const store = deps.store();
  if (!store) throw new StorageUnavailable();
  const sha256 = sha256Hex(bytes);
  // Random key, never derived from the reference or any user input.
  const objectKey = `documents/${actor.companyId}/${randomBytes(32).toString("hex")}`;
  await store.put(objectKey, bytes, "application/pdf");
  try {
    return await withAudit(db, async (tx, audit) => {
      const document = await tx.document.create({
        data: {
          companyId: actor.companyId,
          kind: "other",
          objectKey,
          fileName: safeFileName(row.reference ?? "invoice", "application/pdf"),
          contentType: "application/pdf",
          sizeBytes: bytes.byteLength,
          sha256,
          createdBy: actor.userId,
        },
      });
      const stored = await tx.invoicePdf.create({
        data: {
          companyId: actor.companyId,
          invoiceId,
          documentId: document.id,
          sha256,
          rendererVersion: PDF_RENDERER_VERSION,
          createdBy: actor.userId,
        },
      });
      await audit({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        action: "invoice.pdf_stored",
        target: { type: "invoice", id: invoiceId },
        after: { documentId: document.id, sha256, sizeBytes: bytes.byteLength },
      });
      return stored;
    });
  } catch (error) {
    // Never leave an orphaned object behind.
    await store.delete(objectKey).catch(() => undefined);
    // A concurrent request stored it first: use that one.
    if (isUniqueViolation(error, "invoice_id")) {
      const winner = await db.invoicePdf.findUnique({
        where: {
          companyId_invoiceId: { companyId: actor.companyId, invoiceId },
        },
      });
      if (winner) return winner;
    }
    throw error;
  }
}

export function invoicePdfHandlers(deps: PdfDeps) {
  /**
   * A 5-minute private download link to the stored PDF (stored now if this
   * is the first request). Drafts have no PDF.
   */
  const link: PolicyHandler<{ params: Promise<{ id: string }> }> = async ({
    actor,
    request,
    context,
  }) => {
    const id = uuidOrNull((await context.params).id);
    requireSameCompany(
      actor,
      id
        ? await deps.db().invoice.findUnique({
            where: { id },
            select: { companyId: true },
          })
        : null,
    );
    await throttle(deps.db(), "download.sign", {
      userId: actor.userId,
      ip: clientIp(request.headers),
    });
    let stored: Stored;
    try {
      stored = await ensureInvoicePdf(deps, actor, id!);
    } catch (error) {
      if (error instanceof NotIssued)
        return privateJson(
          { error: "Issue the invoice first; drafts have no PDF" },
          { status: 409 },
        );
      if (error instanceof PdfLimitError)
        return privateJson(
          {
            error:
              "PDF generation is temporarily unavailable. Try again later.",
          },
          { status: 503, headers: { "retry-after": "5" } },
        );
      if (error instanceof StorageUnavailable)
        return privateJson(
          { error: "File storage isn't available right now. Try again later." },
          { status: 503 },
        );
      throw error;
    }
    const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
    const token = signLink(
      { documentId: stored.documentId, companyId: actor.companyId, exp },
      deps.secret(),
    );
    return privateJson({
      documentId: stored.documentId,
      sha256: stored.sha256,
      rendererVersion: stored.rendererVersion,
      url: `/api/files/${token}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  };
  return { link };
}
