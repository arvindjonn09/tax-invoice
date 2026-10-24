import { getDatabase } from "@/server/auth";
import { withPolicy } from "@/server/authz";
import { employeeHandlers } from "@/server/employees/handlers";

export const dynamic = "force-dynamic";

/** Employee-role logins an employee record can link to (owner, manager). */
export const GET = withPolicy(
  "employee.write",
  employeeHandlers(getDatabase).linkable,
);
