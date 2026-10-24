import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { invoiceHandlers } from "@/server/invoices/handlers";

export const dynamic = "force-dynamic";

const handlers = invoiceHandlers(getDatabase);

/** Validate, number and freeze the document (owner, accountant). */
export const POST = withPolicy("invoice.issue", handlers.issue);
