import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { invoiceHandlers } from "@/server/invoices/handlers";

export const dynamic = "force-dynamic";

const handlers = invoiceHandlers(getDatabase);

/** Void an issued document with a reason (owner, accountant; final). */
export const POST = withPolicy("invoice.issue", handlers.void);
