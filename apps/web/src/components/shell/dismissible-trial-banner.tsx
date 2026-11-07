"use client";

import { type ReactNode, useState, useSyncExternalStore } from "react";

const noSubscribe = () => () => undefined;

/**
 * The warning-phase trial banner (S8 AC4): dismissible for the browser
 * session, remembered per last day so an extension shows it again. Storage
 * can be missing or throw (private windows): the banner then just shows.
 */
export function DismissibleTrialBanner({
  storageKey,
  children,
}: {
  storageKey: string;
  children: ReactNode;
}) {
  // Read once on mount from session storage; the server render always shows
  // the banner (it can't know), so there's no flash of a missing banner.
  const dismissedEarlier = useSyncExternalStore(
    noSubscribe,
    () => {
      try {
        return window.sessionStorage.getItem(storageKey) === "1";
      } catch {
        return false; // no session storage: keep showing the banner
      }
    },
    () => false,
  );
  const [dismissedNow, setDismissedNow] = useState(false);
  const dismissed = dismissedEarlier || dismissedNow;
  if (dismissed) return null;
  return (
    <section
      aria-label="Trial"
      className="flex flex-wrap items-center gap-3 border-b-2 border-warning-foreground bg-warning p-4 text-warning-foreground"
    >
      {children}
      <button
        type="button"
        className="ml-auto inline-flex min-h-11 items-center rounded-md px-3 underline"
        onClick={() => {
          try {
            window.sessionStorage.setItem(storageKey, "1");
          } catch {
            // Dismissed for this page view only.
          }
          setDismissedNow(true);
          // Focus goes to the page heading, never lost (docs/design).
          const heading = document.querySelector<HTMLElement>("main h1");
          if (heading) {
            heading.tabIndex = -1;
            heading.focus();
          }
        }}
      >
        Dismiss
      </button>
    </section>
  );
}
