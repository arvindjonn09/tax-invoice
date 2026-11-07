import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out";

/**
 * The operator area's own minimal layout (design §13): no company shell and
 * no company links. Nothing here links to the area for anyone else.
 */
export function OperatorShell({
  email,
  nav = true,
  children,
}: {
  email: string;
  nav?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-30 focus:rounded-sm focus:bg-card focus:px-4 focus:py-2"
      >
        Skip to main content
      </a>
      <header className="border-b bg-card text-card-foreground">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-3 md:px-6">
          <p className="text-lg font-bold">JobFlow operator</p>
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm [overflow-wrap:anywhere]">{email}</span>
            <SignOutButton />
          </div>
        </div>
        {nav ? (
          <nav
            aria-label="Operator"
            className="mx-auto flex max-w-5xl flex-wrap gap-4 px-4 pb-2 md:px-6"
          >
            <Link
              href="/operator"
              className="inline-flex min-h-11 items-center font-semibold underline"
            >
              Extension requests
            </Link>
            <Link
              href="/operator/companies"
              className="inline-flex min-h-11 items-center font-semibold underline"
            >
              Companies
            </Link>
          </nav>
        ) : null}
        <p className="border-b bg-warning px-4 py-2 text-center text-sm font-medium text-warning-foreground">
          Operator area · actions are audited
        </p>
      </header>
      <main id="main" className="mx-auto max-w-5xl space-y-6 px-4 py-8 md:px-6">
        {children}
      </main>
    </>
  );
}
