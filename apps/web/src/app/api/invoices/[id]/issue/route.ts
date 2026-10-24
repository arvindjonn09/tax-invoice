import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { documentDeps } from "@/server/documents";
import { invoiceHandlers } from "@/server/invoices/handlers";
import { ensureInvoicePdf } from "@/server/invoices/pdf-store";

export const dynamic = "force-dynamic";

const handlers = invoiceHandlers(getDatabase, {
  afterIssue: (actor, invoiceId) =>
    ensureInvoicePdf(documentDeps, actor, invoiceId),
});

/** Validate, number and freeze the document (owner, accountant); store its PDF. */
export const POST = withPolicy("invoice.issue", handlers.issue);
