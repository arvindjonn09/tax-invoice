import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { PortalDirectory } from "@/features/portal/directory";
export const dynamic = "force-dynamic";
export const metadata = { title: "My offers · JobFlow" };
export default async function OffersPage() {
  const actor = await requireActor("company.read");
  if (actor.role !== "subcontractor") notFound();
  return <PortalDirectory jobsOnly={false} />;
}
