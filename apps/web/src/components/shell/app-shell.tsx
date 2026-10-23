import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { DemoDataBanner, DesignPreviewBanner } from "./banners";
import { type NavLink, SidebarNav } from "./sidebar-nav";

/**
 * The frame every signed-in page renders in: skip link → banners → header →
 * navigation → one main landmark. Demo status is decided on the server and
 * rendered on first paint, so the banner can never flash or be dismissed.
 */
export function AppShell({
  companyName,
  roleLabel,
  navigation,
  demoPresent,
  preview = false,
  children,
}: {
  companyName: string;
  roleLabel: string;
  navigation: readonly NavLink[];
  demoPresent: boolean;
  preview?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only z-50 rounded-sm bg-card p-4 text-card-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to main content
      </a>
      {demoPresent ? <DemoDataBanner /> : null}
      {preview ? <DesignPreviewBanner /> : null}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b bg-card px-4 py-2 text-card-foreground">
        <div className="flex flex-wrap items-baseline gap-2">
          <strong>JobFlow</strong>
          <span className="text-muted-foreground">
            {companyName} · {roleLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <ThemeToggle />
          <Link className="underline" href="/account">
            Account
          </Link>
        </div>
      </header>
      <div className="flex flex-1 flex-col lg:flex-row">
        <SidebarNav items={navigation} />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 space-y-6 px-4 py-6 md:px-6 lg:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
