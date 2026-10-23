import { redirect } from "next/navigation";
import { requireActor } from "@/server/authz";
import { homeFor } from "@/server/navigation";

export const dynamic = "force-dynamic";

/** After sign-in: the first module this role can open. */
export default async function Home() {
  const actor = await requireActor("company.read");
  redirect(homeFor(actor.role));
}
