import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { TimesheetsView } from "@/features/timesheets/view";
export const dynamic = "force-dynamic";
export const metadata = { title: "Timesheets · JobFlow" };
export default async function TimesheetsPage() {
  const actor = await requireActor("company.read");
  const office = can(actor.role, "timesheet.approve");
  if (!office && actor.role !== "employee") notFound();
  return (
    <TimesheetsView
      office={office}
      showCost={can(actor.role, "employee.cost_rate.read")}
    />
  );
}
