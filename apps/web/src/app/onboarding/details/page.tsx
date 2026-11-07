import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@jobflow/authz";
import { SiteHeader } from "@/components/landing/site-header";
import { buttonVariants } from "@/components/ui/button";
import { ContactDetailsForm } from "@/features/company/contact-details-form";
import { LogoUploader } from "@/features/company/logo-uploader";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { PATH_HEADER } from "@/server/routes/public";
import { chooserFor, loginFor } from "@/server/routes/safe-next";

export const metadata: Metadata = {
  title: "Add your contact details · JobFlow",
};
export const dynamic = "force-dynamic";

/**
 * Onboarding step 2 (S5 AC8, design §9): the optional details, or "Skip for
 * now". Owners only, and not while the company is read-only.
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
  const owner = await getDatabase().user.findUniqueOrThrow({
    where: { id: actor.userId },
    select: { email: true },
  });
  const company = await getDatabase().company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: {
      phone: true,
      businessEmail: true,
      website: true,
      about: true,
      logoDocumentId: true,
    },
  });
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-16 md:px-6">
        <p className="text-sm font-medium text-muted-foreground">Step 2 of 2</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Add your contact details
        </h1>
        <p className="mt-4 text-muted-foreground">
          Shown on your quotes and invoices. You can change these later in
          Settings.
        </p>
        <section className="mt-8 space-y-6 rounded-2xl border bg-card p-6 text-card-foreground md:p-8">
          <LogoUploader
            hasLogo={Boolean(company.logoDocumentId)}
            editable
            heading="h2"
          />
          <ContactDetailsForm
            details={{
              phone: company.phone,
              // Prefilled with the login email; it's only a display value.
              businessEmail: company.businessEmail ?? owner.email,
              website: company.website,
              about: company.about,
            }}
            editable
            submitLabel="Save and continue"
            afterSave="/home"
            secondary={
              <Link
                href="/home"
                className={buttonVariants({ variant: "outline" })}
              >
                Skip for now
              </Link>
            }
          />
        </section>
      </main>
    </>
  );
}
