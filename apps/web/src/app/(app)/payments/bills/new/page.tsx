import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { BillForm } from "@/features/payments/bill-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Record bill · JobFlow" };

export default async function NewBillPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "bill.write")) notFound();
  return <BillForm today={sydneyToday()} />;
}
