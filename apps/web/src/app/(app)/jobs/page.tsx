import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { PortalDirectory } from "@/features/portal/directory";
import { JobsDirectory } from "@/features/jobs/directory";
export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs · JobFlow" };
export default async function JobsPage() {
  const actor = await requireActor("company.read");
  if (actor.role === "subcontractor") return <PortalDirectory jobsOnly />;
  const office = can(actor.role, "job.read_all");
  if (!office && actor.role !== "employee") notFound();
  return (
    <JobsDirectory office={office} editable={can(actor.role, "job.write")} />
  );
}
