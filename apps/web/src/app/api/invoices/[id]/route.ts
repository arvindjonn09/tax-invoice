import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { invoiceHandlers } from "@/server/invoices/handlers";

export const dynamic = "force-dynamic";

const handlers = invoiceHandlers(getDatabase);

/** An invoice or credit note with lines and credit notes. */
export const GET = withPolicy("invoice.read", handlers.read);
/** Edit a draft (header and/or all lines). Issued documents: 409. */
export const PATCH = withPolicy("invoice.write", handlers.update);
/** Discard a draft. Issued documents are never deleted. */
export const DELETE = withPolicy("invoice.write", handlers.discard);
