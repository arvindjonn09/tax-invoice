import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { PaymentsHub, type View } from "@/features/payments/hub";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments · JobFlow" };

const VIEWS: readonly View[] = ["bills", "payments", "receipts"];

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "payment.read") || !can(actor.role, "bill.read"))
    notFound();
  const { view } = await searchParams;
  return (
    <PaymentsHub
      key={view ?? "bills"}
      view={VIEWS.find((item) => item === view) ?? "bills"}
      canRecordBills={can(actor.role, "bill.write")}
      canRecordPayments={can(actor.role, "payment.write")}
    />
  );
}
