import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { employeeHandlers } from "@/server/employees/handlers";

export const dynamic = "force-dynamic";

const handlers = employeeHandlers(getDatabase);

/** Employees of the active company (?status=active|inactive|all, ?q=, paged). */
export const GET = withPolicy("employee.read", handlers.list);
/** Add an employee (owner, manager; audited). */
export const POST = withPolicy("employee.write", handlers.create);
