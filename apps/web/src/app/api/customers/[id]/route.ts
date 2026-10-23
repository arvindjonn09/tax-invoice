import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { customerHandlers } from "@/server/customers/handlers";

export const dynamic = "force-dynamic";

const handlers = customerHandlers(getDatabase);

/** A customer with contacts and locations; other companies' ids are 404. */
export const GET = withPolicy("customer.read", handlers.read);
/** Edit, archive (`archived: true`) or restore a customer (audited). */
export const PATCH = withPolicy("customer.write", handlers.update);
