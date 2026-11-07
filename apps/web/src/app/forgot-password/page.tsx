import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/site-header";
import { turnstileSiteKey } from "@/server/security/turnstile";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Reset your password · JobFlow" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-xl px-4 py-16 md:px-6">
        <h1 className="text-3xl font-bold tracking-tight">
          Reset your password
        </h1>
        <p className="mt-2 text-muted-foreground">
          Enter your account email and we&apos;ll send you a link.
        </p>
        <section className="mt-8 rounded-2xl border bg-card p-6 text-card-foreground md:p-8">
          <ForgotForm turnstileSiteKey={turnstileSiteKey()} />
        </section>
      </main>
    </>
  );
}
