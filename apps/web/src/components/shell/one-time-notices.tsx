"use client";

import { useState } from "react";
import type { ShownNotice } from "@/server/trial/notices";

/** One-time notices above the page content (docs/design/signup-trial.md §12a). */
export function OneTimeNotices({
  notices,
  companyId,
  supportEmail,
}: {
  notices: readonly ShownNotice[];
  companyId: string;
  supportEmail: string;
}) {
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const visible = notices.filter((n) => !dismissed.includes(n.noticeKey));
  if (!visible.length) return null;
  return (
    <div className="mb-6 space-y-3">
      {visible.map((notice) => (
        <div
          key={notice.noticeKey}
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {notice.text}
          </p>
          {notice.canRequest ? (
            // Email until the request form at /settings/trial lands (#232),
            // as the trial banner does.
            <a
              href={`mailto:${supportEmail}?subject=${encodeURIComponent("Trial extension request")}`}
              className="inline-flex min-h-11 items-center underline"
            >
              Request extension
            </a>
          ) : null}
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-md px-3 underline"
            onClick={() => {
              setDismissed((keys) => [...keys, notice.noticeKey]);
              void fetch("/api/notices/dismiss", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  noticeKey: notice.noticeKey,
                  companyId,
                }),
              }).catch(() => undefined);
              const heading = document.querySelector<HTMLElement>("main h1");
              if (heading) {
                heading.tabIndex = -1;
                heading.focus();
              }
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
