import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { Directory } from "@/features/customers/directory";
export const dynamic = "force-dynamic";
export const metadata = { title: "Customers · JobFlow" };
export default async function CustomersPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "customer.read")) notFound();
  return <Directory editable={can(actor.role, "customer.write")} />;
}
