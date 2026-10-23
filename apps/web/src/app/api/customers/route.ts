import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { customerHandlers } from "@/server/customers/handlers";

export const dynamic = "force-dynamic";

const handlers = customerHandlers(getDatabase);

/** Search customers (?q, ?status=active|archived|all, paged). Pickers use active. */
export const GET = withPolicy("customer.read", handlers.list);
/** Add a customer (owner, manager; audited). */
export const POST = withPolicy("customer.write", handlers.create);
