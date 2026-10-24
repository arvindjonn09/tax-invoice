import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { getDatabase } from "@/server/auth";
import { requireActor } from "@/server/authz";
import { uuidOrNull } from "@/server/http/fields";
import { ReceiptDetail } from "@/features/payments/settlement-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Customer receipt · JobFlow" };

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recorded?: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "payment.read")) notFound();
  const [{ id }, { recorded }] = await Promise.all([params, searchParams]);
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().customerReceipt.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  return (
    <ReceiptDetail
      key={id}
      id={id}
      canVoid={can(actor.role, "payment.write")}
      recorded={recorded === "1"}
    />
  );
}
