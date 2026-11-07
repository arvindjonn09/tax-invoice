"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export type SetupChecklistItem = {
  id: string;
  label: string;
  done: boolean;
  href: string;
};

/**
 * "Finish setting up your company" on the owner's home (S5 AC8, design §10).
 * Each item says "Done" or "To do" in text, not by icon alone. Dismiss asks no
 * confirmation and moves focus to the page heading.
 */
export function SetupChecklist({ items }: { items: SetupChecklistItem[] }) {
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function dismiss() {
    setPending(true);
    setError(null);
    const response = await fetch("/api/company/setup-checklist/dismiss", {
      method: "POST",
    }).catch(() => undefined);
    setPending(false);
    if (!response?.ok) {
      setError("We couldn't dismiss this. Try again.");
      return;
    }
    setHidden(true);
    const heading = document.querySelector<HTMLElement>("main h1, h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }

  if (hidden) return null;
  return (
    <section
      aria-labelledby="setup-checklist-heading"
      className="space-y-4 rounded-lg border bg-card p-6 text-card-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="setup-checklist-heading" className="text-xl font-semibold">
          Finish setting up your company
        </h2>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => void dismiss()}
        >
          Dismiss
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-3">
            <span aria-hidden="true">{item.done ? "✓" : "○"}</span>
            <span>{item.label}</span>
            <span className="text-sm text-muted-foreground">
              {item.done ? "Done" : "To do"}
            </span>
            {item.done ? null : (
              <Link
                href={item.href}
                className="inline-flex min-h-11 items-center font-semibold underline"
              >
                Add<span className="sr-only"> {item.label.toLowerCase()}</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
