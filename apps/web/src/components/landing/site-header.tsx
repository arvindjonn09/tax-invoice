// Public site header shared by the landing and sign-up pages (#240, #245).
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";

export const EARLY_ACCESS =
  "mailto:jobflow@shivomsangha.com?subject=JobFlow%20early%20access&body=Business%20name%3A%0AABN%20(optional)%3A%0AYour%20name%3A%0APhone%3A%0AWhat%20work%20do%20you%20do%3F%3A";

export function SiteHeader({
  sections = [],
}: {
  sections?: { href: string; label: string }[];
}) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-30 focus:rounded-sm focus:bg-card focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="z-10 border-b border-border/40 bg-background lg:sticky lg:top-0">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-3 md:px-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold">
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"
            >
              J
            </span>
            JobFlow
          </Link>
          {sections.length > 0 ? (
            <nav aria-label="Page sections" className="hidden lg:block">
              <ul className="flex gap-6 text-sm font-medium">
                {sections.map((item) => (
                  <li key={item.href}>
                    <a
                      className="inline-flex min-h-11 items-center hover:text-link hover:underline"
                      href={item.href}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <ThemeToggle />
            <Link
              href="/login"
              className={buttonVariants({ variant: "outline" })}
            >
              Sign in
            </Link>
            <Link href="/signup" className={buttonVariants()}>
              Sign up
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
