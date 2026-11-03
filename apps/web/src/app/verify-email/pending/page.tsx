import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/landing/site-header";
import { getAuth, getDatabase, resolveActor } from "@/server/auth";
import { PendingActions } from "./pending-actions";

export const metadata: Metadata = { title: "Verify your email · JobFlow" };
export const dynamic = "force-dynamic";

/** The only page an unverified, signed-in user can reach (S3 AC4). */
export default async function VerifyPendingPage() {
  const resolution = await resolveActor(
    getAuth(),
    getDatabase(),
    await headers(),
  );
  if (resolution.status === "signed-out") redirect("/login");
  if (resolution.status !== "unverified") redirect("/home");
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-xl px-4 py-16 md:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Check your email</h1>
        <section className="mt-8 space-y-4 rounded-2xl border bg-card p-6 text-card-foreground md:p-8">
          <p>
            We sent a verification link to <strong>{resolution.email}</strong>.
            Open it to finish setting up your account.
          </p>
          <p className="text-sm text-muted-foreground">
            The link expires after 24 hours. Requesting a new one cancels the
            old link.
          </p>
          <PendingActions />
        </section>
      </main>
    </>
  );
}
