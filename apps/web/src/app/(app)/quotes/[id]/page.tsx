import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { getDatabase } from "@/server/auth";
import { requireActor } from "@/server/authz";
import { uuidOrNull } from "@/server/http/fields";
import { quoteDay } from "@/server/quotes/registration";
import { QuotePage } from "@/features/quotes/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quote · JobFlow" };

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "quote.read")) notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().quote.findFirst({
      where: { id, companyId: actor.companyId },
      select: { id: true },
    }))
  )
    notFound();
  const { today, registeredToday } = await quoteDay(actor.companyId);
  return (
    <QuotePage
      key={id}
      id={id}
      editable={can(actor.role, "quote.write")}
      registeredToday={registeredToday}
      today={today}
    />
  );
}
