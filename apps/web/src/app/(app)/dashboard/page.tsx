import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { requireActor } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { Dashboard } from "@/features/dashboard/dashboard";
export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · JobFlow" };
export default async function DashboardPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "job.profit.read")) notFound();
  return <Dashboard today={sydneyToday()} />;
}
