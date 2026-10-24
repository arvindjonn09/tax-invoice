import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { companyGstStatusOn, sydneyToday } from "@/server/company/gst";
import { InvoiceBuilder } from "@/features/invoices/builder";
export const dynamic = "force-dynamic";
export const metadata = { title: "New invoice · JobFlow" };
export default async function NewInvoicePage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "invoice.write")) notFound();
  const today = sydneyToday();
  const { registered } = await companyGstStatusOn(
    getDatabase(),
    actor.companyId,
    today,
  );
  return (
    <InvoiceBuilder
      initial={null}
      registeredToday={registered}
      today={today}
      canIssue={can(actor.role, "invoice.issue")}
      creditsReference={null}
    />
  );
}
