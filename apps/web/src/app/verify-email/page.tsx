import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/site-header";
import { VerifyEmail } from "./verify-client";

// The token travels in the URL fragment; no-referrer keeps the page URL out
// of any outgoing request (S3 AC1).
export const metadata: Metadata = {
  title: "Verify your email · JobFlow",
  referrer: "no-referrer",
};

export default function VerifyEmailPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-xl px-4 py-16 md:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Verify your email</h1>
        <section className="mt-8 rounded-2xl border bg-card p-6 text-card-foreground md:p-8">
          <VerifyEmail />
        </section>
      </main>
    </>
  );
}
