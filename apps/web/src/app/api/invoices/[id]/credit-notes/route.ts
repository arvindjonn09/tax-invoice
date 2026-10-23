import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { invoiceHandlers } from "@/server/invoices/handlers";

export const dynamic = "force-dynamic";

const handlers = invoiceHandlers(getDatabase);

/** Draft a credit note for an issued invoice (full by default). */
export const POST = withPolicy("invoice.issue", handlers.credit);
