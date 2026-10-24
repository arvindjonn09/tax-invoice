import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { uuidOrNull } from "@/server/http/fields";
import { ContractorDetail } from "@/features/contractors/detail";
export const dynamic = "force-dynamic";
export const metadata = { title: "Contractor · JobFlow" };
export default async function ContractorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "contractor.read")) notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().contractor.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  return (
    <ContractorDetail id={id} editable={can(actor.role, "contractor.write")} />
  );
}
