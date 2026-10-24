import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { requireActor } from "@/server/authz";
import { ContractorDirectory } from "@/features/contractors/directory";
export const dynamic = "force-dynamic";
export const metadata = { title: "Contractors · JobFlow" };
export default async function ContractorsPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "contractor.read")) notFound();
  return <ContractorDirectory editable={can(actor.role, "contractor.write")} />;
}
