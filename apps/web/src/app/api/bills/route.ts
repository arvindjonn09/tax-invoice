import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { billHandlers } from "@/server/bills/handlers";

export const dynamic = "force-dynamic";

const handlers = billHandlers(getDatabase);

/** Supplier and contractor bills (?jobId adds the job's bill cost; paged). */
export const GET = withPolicy("bill.read", handlers.list);
/** Record a bill; its job cost and creditable GST are fixed when recorded. */
export const POST = withPolicy("bill.write", handlers.create);
