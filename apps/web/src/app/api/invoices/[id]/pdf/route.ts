import { withPolicy } from "@/server/authz";
import { documentDeps } from "@/server/documents";
import { invoicePdfHandlers } from "@/server/invoices/pdf-store";

export const dynamic = "force-dynamic";

/**
 * A short-lived private download link to the issued document's PDF, stored
 * once from its frozen snapshot (office roles with invoice.read).
 */
export const POST = withPolicy(
  "invoice.read",
  invoicePdfHandlers(documentDeps).link,
);
