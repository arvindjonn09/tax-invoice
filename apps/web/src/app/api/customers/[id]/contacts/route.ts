import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { customerHandlers } from "@/server/customers/handlers";

export const dynamic = "force-dynamic";

const handlers = customerHandlers(getDatabase);

/** Add a contact to a customer (audited). */
export const POST = withPolicy("customer.write", handlers.addContact);
