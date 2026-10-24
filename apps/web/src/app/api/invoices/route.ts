import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { invoiceHandlers } from "@/server/invoices/handlers";

export const dynamic = "force-dynamic";

const handlers = invoiceHandlers(getDatabase);

/** Invoices and credit notes (?status, ?kind, ?customerId, ?jobId, paged). */
export const GET = withPolicy("invoice.read", handlers.list);
/** Start a draft invoice (audited). */
export const POST = withPolicy("invoice.write", handlers.create);
