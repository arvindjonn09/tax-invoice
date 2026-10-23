import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { employeeHandlers } from "@/server/employees/handlers";

export const dynamic = "force-dynamic";

const handlers = employeeHandlers(getDatabase);

/** One employee; another company's id is a 404. */
export const GET = withPolicy("employee.read", handlers.read);
/** Edit, link a user, deactivate or reactivate (owner, manager; audited). */
export const PATCH = withPolicy("employee.write", handlers.update);
