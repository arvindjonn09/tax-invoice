import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/site-header";
import { TERMS_VERSION } from "@/server/account/terms";
import { supportEmail } from "@/server/email";

export const metadata: Metadata = { title: "Terms of Service · JobFlow" };

// Versioned placeholder (S2 AC6, E5): production sign-up stays closed until
// reviewed text replaces it.
export default function Page() {
  return (
    <>
      <SiteHeader />
      <main
        id="main"
        className="mx-auto max-w-3xl space-y-6 px-4 py-16 md:px-6"
      >
        <h1 className="text-3xl font-bold tracking-tight">Terms of Service</h1>
        <p className="inline-flex rounded-full border bg-warning px-3 py-1 text-sm font-medium text-warning-foreground">
          Version {TERMS_VERSION}: placeholder, not final legal text
        </p>
        <p>
          JobFlow is in early access. The full Terms of Service is being
          prepared and will replace this page before public launch. Accounts
          created now are asked to accept the reviewed version when it is
          published.
        </p>
        <p>
          Questions? Email{" "}
          <a className="text-link underline" href={`mailto:${supportEmail()}`}>
            {supportEmail()}
          </a>
          .
        </p>
      </main>
    </>
  );
}
