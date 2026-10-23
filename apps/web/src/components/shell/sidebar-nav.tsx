"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";

export type NavLink = { href: string; label: string; icon: string };

function Links({
  items,
  collapsed,
  onNavigate,
}: {
  items: readonly NavLink[];
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? "";
  return (
    <ul className="space-y-1">
      {items.map((item) => {
        const current =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              {...(onNavigate ? { onClick: onNavigate } : {})}
              {...(current ? { "aria-current": "page" as const } : {})}
              {...(collapsed ? { title: item.label } : {})}
              className={`flex min-h-11 items-center gap-3 rounded-sm px-3 ${
                current
                  ? "border-l-4 border-info-foreground bg-info font-semibold text-info-foreground"
                  : "hover:bg-muted"
              }`}
            >
              <span aria-hidden="true" className="w-6 text-center">
                {item.icon}
              </span>
              <span className={collapsed ? "sr-only" : undefined}>
                {item.label}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Desktop (≥1024px): a 240px sidebar that collapses to 72px icons (labels stay
 * available to assistive tech). Smaller screens: a labelled menu button opens
 * a modal <dialog> drawer: background is inert, Escape closes, focus returns.
 */
export function SidebarNav({ items }: { items: readonly NavLink[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const close = () => {
    drawer.current?.close();
    opener.current?.focus();
  };

  return (
    <>
      <div className="border-b p-2 lg:hidden">
        <button
          ref={opener}
          type="button"
          aria-haspopup="dialog"
          onClick={() => drawer.current?.showModal()}
          className="min-h-11 rounded-sm border border-control-border px-4"
        >
          <span aria-hidden="true">☰ </span>Menu
        </button>
      </div>
      <dialog
        ref={drawer}
        aria-label="Main navigation"
        onClose={() => opener.current?.focus()}
        className="m-0 h-full max-h-none w-72 max-w-[85vw] bg-card p-4 text-card-foreground backdrop:bg-foreground/40"
      >
        <div className="mb-4 flex items-center justify-between">
          <strong>JobFlow</strong>
          <button
            type="button"
            onClick={close}
            className="min-h-11 rounded-sm border border-control-border px-4"
          >
            Close menu
          </button>
        </div>
        <nav aria-label="Main">
          <Links items={items} collapsed={false} onNavigate={close} />
        </nav>
      </dialog>
      <nav
        aria-label="Main"
        className={`hidden shrink-0 border-r bg-card p-2 text-card-foreground lg:block ${
          collapsed ? "w-[72px]" : "w-60"
        }`}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="mb-2 min-h-11 w-full rounded-sm border border-control-border px-3 text-left"
        >
          <span aria-hidden="true">{collapsed ? "»" : "«"} </span>
          <span className={collapsed ? "sr-only" : undefined}>
            {collapsed ? "Expand navigation" : "Collapse navigation"}
          </span>
        </button>
        <Links items={items} collapsed={collapsed} />
      </nav>
    </>
  );
}
