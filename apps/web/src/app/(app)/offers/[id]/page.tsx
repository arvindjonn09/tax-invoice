import { notFound } from "next/navigation";
import { requireActor } from "@/server/authz";
import { getDatabase } from "@/server/auth";
import { uuidOrNull } from "@/server/http/fields";
import { PortalDetail } from "@/features/portal/detail";
export const dynamic = "force-dynamic";
export const metadata = { title: "My work · JobFlow" };
export default async function OfferPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor("company.read");
  if (actor.role !== "subcontractor") notFound();
  const { id } = await params;
  if (
    !uuidOrNull(id) ||
    !(await getDatabase().contractorOffer.findFirst({
      where: {
        id,
        companyId: actor.companyId,
        contractor: { userId: actor.userId, companyId: actor.companyId },
      },
      select: { id: true },
    }))
  )
    notFound();
  return <PortalDetail id={id} />;
}
