import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { uuidOrNull } from "@/server/http/fields";
import { assignedTo } from "@/server/jobs/my-jobs";
import { JobDetail } from "@/features/jobs/detail";
export const dynamic = "force-dynamic";
export const metadata = { title: "Job · JobFlow" };
export default async function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  const office = can(actor.role, "job.read_all");
  if (!office && actor.role !== "employee") notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().job.findFirst({
      where: {
        id,
        ...(office ? { companyId: actor.companyId } : assignedTo(actor)),
      },
      select: { id: true },
    }))
  )
    notFound();
  return (
    <JobDetail
      id={id}
      office={office}
      editable={can(actor.role, "job.write")}
    />
  );
}
