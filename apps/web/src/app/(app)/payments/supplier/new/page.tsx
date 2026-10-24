import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { uuidOrNull } from "@/server/http/fields";
import { SupplierPaymentForm } from "@/features/payments/settle-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Record payment · JobFlow" };

export default async function NewSupplierPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ billId?: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "payment.write") || !can(actor.role, "bill.read"))
    notFound();
  const { billId } = await searchParams;
  return (
    <SupplierPaymentForm
      today={sydneyToday()}
      billId={uuidOrNull(billId ?? "")}
    />
  );
}
