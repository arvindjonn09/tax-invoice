import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { trialStatus } from "@jobflow/domain";
import { AppShell } from "@/components/shell/app-shell";
import { TrialBanner } from "@/components/shell/banners";
import { supportEmail } from "@/server/email";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { ROLE_LABELS, navLinksFor } from "@/server/shell";

export const dynamic = "force-dynamic";

/** Roles that see the trial countdown; others only see that it has ended (S8). */
const TRIAL_VIEWERS = new Set(["owner", "manager", "accountant"]);

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
  if (resolution.status === "unverified") redirect("/verify-email/pending");
  // Verified, but no company yet: set one up (S1, S5).
  if (resolution.status === "no-membership") redirect("/onboarding");
  if (resolution.status === "choose-company") redirect("/choose-company");
  const { actor } = resolution;
  const company = await getDatabase().company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: {
      name: true,
      isDemo: true,
      accessMode: true,
      trialLastDay: true,
    },
  });
  const trialLastDay =
    company.accessMode === "trial"
      ? (company.trialLastDay?.toISOString().slice(0, 10) ?? null)
      : null;
  return (
    <AppShell
      companyName={company.name}
      roleLabel={ROLE_LABELS[actor.role]}
      navigation={navLinksFor(actor.role)}
      demoPresent={company.isDemo}
      banner={
        trialLastDay ? (
          <TrialBanner
            status={trialStatus(trialLastDay, new Date())}
            lastDay={trialLastDay}
            showCountdown={TRIAL_VIEWERS.has(actor.role)}
            supportEmail={supportEmail()}
          />
        ) : null
      }
    >
      {children}
    </AppShell>
  );
}
