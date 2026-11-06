import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/site-header";
import { ResetForm } from "./reset-form";

// The token travels in the URL fragment; the proxy also sends
// Referrer-Policy: no-referrer for this page (#224).
export const metadata: Metadata = {
  title: "Choose a new password · JobFlow",
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-xl px-4 py-16 md:px-6">
        <h1 className="text-3xl font-bold tracking-tight">
          Choose a new password
        </h1>
        <section className="mt-8 rounded-2xl border bg-card p-6 text-card-foreground md:p-8">
          <ResetForm />
        </section>
      </main>
    </>
  );
}
