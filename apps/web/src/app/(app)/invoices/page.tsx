import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { requireActor } from "@/server/authz";
import { sydneyToday } from "@/server/company/gst";
import { InvoiceList } from "@/features/invoices/list";
export const dynamic = "force-dynamic";
export const metadata = { title: "Invoices · JobFlow" };
export default async function InvoicesPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "invoice.read")) notFound();
  return (
    <InvoiceList
      canWrite={can(actor.role, "invoice.write")}
      today={sydneyToday()}
    />
  );
}
