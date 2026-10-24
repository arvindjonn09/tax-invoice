import { after } from "next/server";
import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { documentDeps } from "@/server/documents";
import { invoiceHandlers } from "@/server/invoices/handlers";
import { ensureInvoicePdf } from "@/server/invoices/pdf-store";
import { log, safeError } from "@/server/log";

export const dynamic = "force-dynamic";

// The PDF is stored after the response is sent (#158): rendering and upload
// took 11s cold. A download before it lands renders the same frozen
// snapshot and stores it once (ensureInvoicePdf resolves the race).
const handlers = invoiceHandlers(getDatabase, {
  afterIssue: async (actor, invoiceId) =>
    after(() =>
      ensureInvoicePdf(documentDeps, actor, invoiceId).catch((error: unknown) =>
        log("warn", "invoice.pdf_deferred", {
          invoiceId,
          error: safeError(error),
        }),
      ),
    ),
});

/** Validate, number and freeze the document (owner, accountant); store its PDF. */
export const POST = withPolicy("invoice.issue", handlers.issue);
