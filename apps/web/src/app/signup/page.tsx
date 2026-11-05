import type { Metadata } from "next";
import Link from "next/link";
import { icons } from "@/components/landing/icons";
import { EARLY_ACCESS, SiteHeader } from "@/components/landing/site-header";
import { buttonVariants } from "@/components/ui/button";
import {
  PRIVACY_VERSION,
  TERMS_VERSION,
  legalTextIsPlaceholder,
} from "@/server/account/terms";
import { isProductionEnvironment } from "@/server/auth";
import { turnstileSiteKey } from "@/server/security/turnstile";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Sign up · JobFlow" };

const benefits = [
  "An Owner account for your business, with your team invited when you're ready.",
  "Business name, ABN, address and logo entered once and reused on quotes and tax invoices.",
  "A free 30-day trial, with a clear countdown so you always know where you stand.",
];

export const dynamic = "force-dynamic";

// Self-service sign-up (#224, ADR 0004). Production keeps the early-access
// card until reviewed Terms and Privacy text replaces the placeholders (E5).
export default function SignupPage() {
  const open = !(
    isProductionEnvironment(process.env) && legalTextIsPlaceholder()
  );
  return (
    <>
      <SiteHeader />
      <main
        id="main"
        className="mx-auto grid max-w-6xl gap-12 px-4 py-16 md:px-6 lg:grid-cols-2 lg:py-24"
      >
        <div className="landing-rise">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Create your JobFlow account
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Run quotes, jobs, contractors, tax invoices and GST for your
            business in one place.
          </p>
          <h2 className="mt-10 text-xl font-semibold">What you get</h2>
          <ul className="mt-4 space-y-3">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex gap-3">
                <span className="mt-0.5 shrink-0 text-link">{icons.check}</span>
                {benefit}
              </li>
            ))}
          </ul>
        </div>
        <section
          aria-labelledby="signup-card"
          className="landing-rise landing-rise-delay self-start rounded-2xl border bg-card p-6 text-card-foreground shadow-[0_8px_24px_rgb(15_23_42/0.16)] md:p-8"
        >
          {open ? (
            <>
              <h2 id="signup-card" className="mb-6 text-2xl font-semibold">
                Start your free 30-day trial
              </h2>
              <SignupForm
                termsVersion={TERMS_VERSION}
                privacyVersion={PRIVACY_VERSION}
                turnstileSiteKey={turnstileSiteKey()}
              />
            </>
          ) : (
            <>
              <p className="inline-flex rounded-full border bg-info px-3 py-1 text-sm font-medium text-info-foreground">
                Opening soon
              </p>
              <h2 id="signup-card" className="mt-4 text-2xl font-semibold">
                Public sign-up is almost ready
              </h2>
              <p className="mt-3 text-muted-foreground">
                Request early access and we&apos;ll set up your business account
                and let you know as soon as you can sign in.
              </p>
              <a
                href={EARLY_ACCESS}
                className={buttonVariants({ className: "mt-6 w-full" })}
              >
                Request early access
              </a>
            </>
          )}
          <hr className="my-6 border-border/40" />
          <p>
            Already have an account?{" "}
            <Link href="/login" className="text-link underline">
              Sign in
            </Link>
          </p>
        </section>
      </main>
    </>
  );
}
