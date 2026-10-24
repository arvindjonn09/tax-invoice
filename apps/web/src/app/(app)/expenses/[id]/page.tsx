import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { uuidOrNull } from "@/server/http/fields";
import { ExpenseDetail } from "@/features/expenses/detail";
export const dynamic = "force-dynamic";
export const metadata = { title: "Expense · JobFlow" };
export default async function ExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "expense.read_all")) notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().expense.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  return (
    <ExpenseDetail
      id={id}
      userId={actor.userId}
      canApprove={can(actor.role, "expense.approve")}
    />
  );
}
