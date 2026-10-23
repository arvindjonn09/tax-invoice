import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { customerHandlers } from "@/server/customers/handlers";

export const dynamic = "force-dynamic";

const handlers = customerHandlers(getDatabase);

/** Edit, archive or restore a contact (audited). */
export const PATCH = withPolicy("customer.write", handlers.updateContact);
