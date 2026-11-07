import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@jobflow/authz";
import { SiteHeader } from "@/components/landing/site-header";
import { buttonVariants } from "@/components/ui/button";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { PATH_HEADER } from "@/server/routes/public";
import { chooserFor, loginFor } from "@/server/routes/safe-next";

export const metadata: Metadata = {
  title: "Add your business details · JobFlow",
};
export const dynamic = "force-dynamic";

/**
 * Onboarding step 2 (S5 AC8, design §9): the optional details, or "Skip for
 * now". Owners only, and not while the company is read-only. #228 puts the S6
 * contact details form here.
 */
export default async function OnboardingDetailsPage() {
  const requestHeaders = await headers();
  const path = requestHeaders.get(PATH_HEADER);
  const resolution = await resolveActor(
    getAuth(),
    getDatabase(),
    requestHeaders,
  );
  if (resolution.status === "signed-out") redirect(loginFor(path));
  if (resolution.status === "unverified") redirect("/verify-email/pending");
  if (resolution.status === "no-membership") redirect("/onboarding");
  if (resolution.status === "choose-company") redirect(chooserFor(path));
  const { actor } = resolution;
  if (!can(actor.role, "company.update") || actor.access.readOnly)
    redirect("/home");
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-16 md:px-6">
        <p className="text-sm font-medium text-muted-foreground">Step 2 of 2</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Add your business details
        </h1>
        <p className="mt-4 text-muted-foreground">
          Your business is set up and your free trial has started. Add your
          business address now so it appears on your quotes and invoices, or
          skip this and add it later in Settings.
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link href="/settings" className={buttonVariants()}>
            Add details in Settings
          </Link>
          <Link href="/home" className={buttonVariants({ variant: "outline" })}>
            Skip for now
          </Link>
        </div>
      </main>
    </>
  );
}
