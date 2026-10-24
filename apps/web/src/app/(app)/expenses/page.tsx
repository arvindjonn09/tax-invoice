import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { ExpensesList } from "@/features/expenses/list";
export const dynamic = "force-dynamic";
export const metadata = { title: "Expenses · JobFlow" };
export default async function ExpensesPage() {
  const actor = await requireActor("company.read");
  const office = can(actor.role, "expense.read_all");
  if (!office && !can(actor.role, "expense.submit_own")) notFound();
  return (
    <ExpensesList
      office={office}
      canApprove={can(actor.role, "expense.approve")}
    />
  );
}
