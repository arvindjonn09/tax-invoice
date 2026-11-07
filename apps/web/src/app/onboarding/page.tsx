import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/landing/site-header";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { PATH_HEADER } from "@/server/routes/public";
import { loginFor } from "@/server/routes/safe-next";
import { supportEmail } from "@/server/email";
import { Onboarding } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your business · JobFlow" };
export const dynamic = "force-dynamic";

/** Verified users without a company set up their business here (S5). */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestHeaders = await headers();
  const resolution = await resolveActor(
    getAuth(),
    getDatabase(),
    requestHeaders,
  );
  if (resolution.status === "signed-out")
    redirect(loginFor(requestHeaders.get(PATH_HEADER)));
  if (resolution.status === "unverified") redirect("/verify-email/pending");
  // A member may set up their own business from the account menu (S12 AC3).
  // Its own trial starts; the self-service limit applies on the server.
  const another = (await searchParams).another === "1";
  if (resolution.status !== "no-membership" && !another) redirect("/home");
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-16 md:px-6">
        <Onboarding supportEmail={supportEmail()} />
      </main>
    </>
  );
}
