import { can } from "@jobflow/authz";
import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { QuotesList } from "@/features/quotes/list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quotes · JobFlow" };

export default async function QuotesPage() {
  const actor = await requireActor("company.read");
  if (!can(actor.role, "quote.read")) notFound();
  return <QuotesList editable={can(actor.role, "quote.write")} />;
}
