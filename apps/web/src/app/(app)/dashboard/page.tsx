import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { getDatabase } from "@/server/auth";
import { requireActorWithAccess } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { setupChecklistFor } from "@/server/company/setup-checklist";
import { Dashboard } from "@/features/dashboard/dashboard";
export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · JobFlow" };
export default async function DashboardPage() {
  const { actor, access } = await requireActorWithAccess("company.read");
  if (!can(actor.role, "job.profit.read")) notFound();
  // The owner's home (#225): what's left to set up, until done or dismissed.
  const checklist = await setupChecklistFor(getDatabase(), actor, access);
  return (
    <Dashboard
      today={sydneyToday()}
      notice={checklist ? <SetupChecklist items={checklist} /> : null}
    />
  );
}
