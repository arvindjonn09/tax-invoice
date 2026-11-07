import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { PATH_HEADER } from "@/server/routes/public";
import { loginFor, safeNextPath } from "@/server/routes/safe-next";
import { ROLE_LABELS } from "@/server/shell";
import { CompanyChooser } from "./chooser";

export const metadata: Metadata = { title: "Choose a company · JobFlow" };
export const dynamic = "force-dynamic";

/** For users who belong to several companies (S1, S12). */
export default async function ChooseCompanyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const db = getDatabase();
  const requestHeaders = await headers();
  const resolution = await resolveActor(getAuth(), db, requestHeaders);
  if (resolution.status === "signed-out")
    redirect(loginFor(requestHeaders.get(PATH_HEADER)));
  const { next } = await searchParams;
  // Where to go once a company is chosen: same-origin paths only (#223).
  const target = safeNextPath(Array.isArray(next) ? next[0] : next);
  if (resolution.status === "unverified") redirect("/verify-email/pending");
  if (resolution.status === "no-membership") redirect("/onboarding");
  const userId =
    resolution.status === "active"
      ? resolution.actor.userId
      : resolution.userId;
  const memberships = await db.membership.findMany({
    where: { userId, isActive: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      companyId: true,
      role: true,
      company: { select: { name: true } },
    },
  });
  if (memberships.length < 2) redirect(target);
  return (
    <main id="main" className="foundation">
      <h1>Choose a company</h1>
      <p>You belong to several companies. Which one do you want to open?</p>
      <section className="rounded-lg border bg-card p-6 text-card-foreground">
        <CompanyChooser
          next={target}
          companies={memberships.map((membership) => ({
            companyId: membership.companyId,
            name: membership.company.name,
            role: ROLE_LABELS[membership.role],
          }))}
        />
      </section>
    </main>
  );
}
