import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { quoteDay } from "@/server/quotes/registration";
import { QuoteBuilder } from "@/features/quotes/builder";

export const dynamic = "force-dynamic";
export const metadata = { title: "New quote · JobFlow" };

export default async function NewQuotePage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "quote.write")) notFound();
  const { today, registeredToday } = await quoteDay(actor.companyId);
  return (
    <QuoteBuilder
      initial={null}
      registeredToday={registeredToday}
      today={today}
    />
  );
}
