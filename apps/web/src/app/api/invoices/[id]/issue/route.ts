import { after } from "next/server";
import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { documentDeps } from "@/server/documents";
import { invoiceHandlers } from "@/server/invoices/handlers";
import { storePdfAfterResponse } from "@/server/invoices/pdf-store";

export const dynamic = "force-dynamic";

// The PDF is stored after the response is sent (#158). A download before it
// lands renders the same frozen snapshot and stores it once.
const handlers = invoiceHandlers(getDatabase, {
  afterIssue: storePdfAfterResponse(documentDeps, after),
});

/** Validate, number and freeze the document (owner, accountant); store its PDF. */
export const POST = withPolicy("invoice.issue", handlers.issue);
