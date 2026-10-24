import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { ReceiptForm } from "@/features/payments/settle-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Record receipt · JobFlow" };

export default async function NewReceiptPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "payment.write") || !can(actor.role, "invoice.read"))
    notFound();
  return <ReceiptForm today={sydneyToday()} />;
}
