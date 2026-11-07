import type { ReactNode } from "react";
import { SiteHeader } from "@/components/landing/site-header";

/** The shared layout for /terms and /privacy (#212). */
export function LegalPage({
  title,
  version,
  effectiveDate,
  draft,
  children,
}: {
  title: string;
  version: string;
  effectiveDate: string;
  draft: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <main
        id="main"
        className="mx-auto max-w-3xl space-y-6 px-4 py-16 md:px-6 [&_h2]:pt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:ml-6 [&_li]:list-disc [&_ul]:space-y-2"
      >
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {draft ? (
          <p className="inline-flex rounded-full border bg-warning px-3 py-1 text-sm font-medium text-warning-foreground">
            Version {version}: draft, not yet in effect
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Version {version}, in effect from {effectiveDate}
          </p>
        )}
        {children}
      </main>
    </>
  );
}
