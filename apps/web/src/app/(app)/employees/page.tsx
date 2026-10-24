import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { requireActor } from "@/server/authz";
import { EmployeeDirectory } from "@/features/employees/directory";
export const dynamic = "force-dynamic";
export const metadata = { title: "Employees · JobFlow" };
export default async function EmployeesPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "employee.read")) notFound();
  return <EmployeeDirectory editable={can(actor.role, "employee.write")} />;
}
