import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { uuidOrNull } from "@/server/http/fields";
import { CustomerDetail } from "@/features/customers/detail";
export const dynamic = "force-dynamic";
export const metadata = { title: "Customer · JobFlow" };
export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "customer.read")) notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().customer.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  return (
    <CustomerDetail id={id} editable={can(actor.role, "customer.write")} />
  );
}
