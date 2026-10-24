import { notFound } from "next/navigation";
import { can } from "@jobflow/authz";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { companyGstPeriods, sydneyToday } from "@/server/company/gst";
import { uuidOrNull } from "@/server/http/fields";
import { InvoicePage } from "@/features/invoices/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Invoice · JobFlow" };
export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "invoice.read")) notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().invoice.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  const today = sydneyToday();
  const periods = await companyGstPeriods(getDatabase(), actor.companyId);
  return (
    <InvoicePage
      id={id}
      periods={periods}
      today={today}
      canWrite={can(actor.role, "invoice.write")}
      canIssue={can(actor.role, "invoice.issue")}
    />
  );
}
