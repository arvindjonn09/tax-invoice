import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/states";
import { JobsDirectory } from "@/features/jobs/directory";
export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs · JobFlow" };
export default async function JobsPage() {
  const actor = await requireActor("company.read");
  if (actor.role === "subcontractor")
    return (
      <>
        <PageHeader title="Jobs" />
        <EmptyState
          title="Contractor job access is on its way"
          description="Your accepted work will be available through the contractor portal. Employee assignments are kept separate."
        />
      </>
    );
  const office = can(actor.role, "job.read_all");
  if (!office && actor.role !== "employee") notFound();
  return (
    <JobsDirectory office={office} editable={can(actor.role, "job.write")} />
  );
}
