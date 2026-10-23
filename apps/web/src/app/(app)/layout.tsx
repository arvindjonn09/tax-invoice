import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { EmptyState } from "@/components/shell/states";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { ROLE_LABELS, navLinksFor } from "@/server/shell";

export const dynamic = "force-dynamic";

/** Every signed-in page: actor, company and demo status come from the server. */
export default async function SignedInLayout({
  children,
}: {
  children: ReactNode;
}) {
  const resolution = await resolveActor(
    getAuth(),
    getDatabase(),
    await headers(),
  );
  if (resolution.status === "signed-out") redirect("/login");
  if (resolution.status !== "active") {
    return (
      <main className="foundation">
        <EmptyState
          title={
            resolution.status === "choose-company"
              ? "Choose a company"
              : "No company access"
          }
          description={
            resolution.status === "choose-company"
              ? "You belong to several companies. Company switching arrives with user management (#27)."
              : "Your account is not an active member of any company. Ask your company owner to invite you."
          }
          action={
            <Link className="underline" href="/account">
              Account and sign out
            </Link>
          }
        />
      </main>
    );
  }
  const { actor } = resolution;
  const company = await getDatabase().company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: { name: true, isDemo: true },
  });
  return (
    <AppShell
      companyName={company.name}
      roleLabel={ROLE_LABELS[actor.role]}
      navigation={navLinksFor(actor.role)}
      demoPresent={company.isDemo}
    >
      {children}
    </AppShell>
  );
}
