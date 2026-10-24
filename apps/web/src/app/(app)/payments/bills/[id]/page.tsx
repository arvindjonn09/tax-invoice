import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { getDatabase } from "@/server/auth";
import { requireActor } from "@/server/authz";
import { uuidOrNull } from "@/server/http/fields";
import { BillDetail } from "@/features/payments/bill-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bill · JobFlow" };

export default async function BillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recorded?: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "bill.read")) notFound();
  const [{ id }, { recorded }] = await Promise.all([params, searchParams]);
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().supplierBill.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  return (
    <BillDetail
      key={id}
      id={id}
      canVoid={can(actor.role, "bill.write")}
      canPay={can(actor.role, "payment.write")}
      recorded={recorded === "1"}
    />
  );
}
