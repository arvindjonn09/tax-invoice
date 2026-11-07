import type { TrialStatus } from "@jobflow/domain";
import type React from "react";
import { DismissibleTrialBanner } from "./dismissible-trial-banner";

/** Persistent, non-dismissible warning whenever demo records are in context. */
export function DemoDataBanner() {
  return (
    <section
      aria-label="Demo Data"
      className="flex flex-wrap items-center gap-2 border-b-2 border-warning-foreground bg-warning p-4 text-warning-foreground"
    >
      <span aria-hidden="true">⚠</span>
      <strong>Demo Data</strong>
      <span>Synthetic demonstration records are present.</span>
    </section>
  );
}

/** Info banner above static design previews (separate from Demo Data). */
export function DesignPreviewBanner() {
  return (
    <section
      aria-label="Design preview"
      className="flex flex-wrap items-center gap-2 border-b-2 border-info-foreground bg-info p-4 text-info-foreground"
    >
      <span aria-hidden="true">ⓘ</span>
      <strong>Design preview — not real data</strong>
      <span>Static layout preview. Financial actions are unavailable.</span>
    </section>
  );
}

/** `d MMM yyyy`, e.g. "1 Dec 2026" (docs/design/signup-trial.md). */
export const shortDate = (day: string) =>
  new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/**
 * Who is looking (S8 AC1–AC2): the owner (who may request an extension),
 * other staff who see trial dates (manager, accountant), or a worker
 * (employee, subcontractor), who sees only the read-only notice.
 */
export type TrialViewer = "owner" | "staff" | "worker";

const ICON = {
  normal: "⏱",
  warning: "⚠",
  critical: "⚠",
  expired: "🔒",
} as const;
const TONE = {
  normal: "border-b bg-muted text-foreground",
  warning:
    "border-b-2 border-warning-foreground bg-warning text-warning-foreground",
  critical:
    "border-b-2 border-danger-foreground bg-danger text-danger-foreground",
  expired:
    "border-b-2 border-danger-foreground bg-danger text-danger-foreground",
} as const;

/** The indicator's text for each phase (S8 AC1): the text carries the state. */
export function trialIndicatorText(status: TrialStatus, lastDay: string) {
  const days = `${status.daysRemaining} ${status.daysRemaining === 1 ? "day" : "days"} remaining`;
  switch (status.phase) {
    case "normal":
      return days;
    case "warning":
      return `${days} · Trial expires on ${shortDate(lastDay)}`;
    case "critical":
      return "Last day of your trial · Read-only from 12:00 am tomorrow (Sydney time)";
    case "expired":
      return `Trial ended ${shortDate(lastDay)} · Read-only`;
  }
}

/**
 * The trial indicator and banner (S8, docs/design/signup-trial.md "Trial
 * indicator and banner"). A server component: workers never receive dates or
 * the support address. Demo and unrestricted companies render nothing (the
 * layout passes no trial). The warning banner can be dismissed for the
 * session; the critical and expired ones can't.
 */
export function TrialBanner({
  status,
  lastDay,
  viewer,
  supportEmail,
}: {
  status: TrialStatus;
  lastDay: string;
  viewer: TrialViewer;
  supportEmail: string;
}) {
  const { phase } = status;
  if (viewer === "worker") {
    if (phase !== "expired") return null;
    return (
      <section
        aria-label="Trial"
        className={`flex flex-wrap items-center gap-2 p-4 ${TONE.expired}`}
      >
        <span aria-hidden="true">{ICON.expired}</span>
        <strong>
          This company&apos;s account is read-only. Contact your owner.
        </strong>
      </section>
    );
  }
  const email = (
    <a className="underline" href={`mailto:${supportEmail}`}>
      {supportEmail}
    </a>
  );
  const request =
    viewer === "owner" && phase !== "normal" ? (
      // Email until the request form at /settings/trial lands (#232), so the
      // owner's way out never leads to a missing page (Codex review).
      <a
        className="inline-flex min-h-11 items-center rounded-md border border-current px-3 font-medium underline-offset-2 hover:underline"
        href={`mailto:${supportEmail}?subject=${encodeURIComponent("Trial extension request")}`}
      >
        Request extension
      </a>
    ) : null;
  const ends = shortDate(lastDay);
  const banner =
    phase === "warning" ? (
      <DismissibleTrialBanner storageKey={`jobflow.trial-banner.${lastDay}`}>
        <span>
          Your trial ends on {ends}.{" "}
          {viewer === "owner" ? "Request more time, or email " : "Email "}
          {email}
          {viewer === "owner" ? "." : " for more time."}
        </span>
        {request}
      </DismissibleTrialBanner>
    ) : phase === "critical" ? (
      <TrialBannerBody tone={TONE.critical}>
        <span>
          Your trial ends today.{" "}
          {viewer === "owner" ? "Request more time, or email " : "Email "}
          {email}
          {viewer === "owner" ? "." : " for more time."}
        </span>
        {request}
      </TrialBannerBody>
    ) : phase === "expired" ? (
      <TrialBannerBody tone={TONE.expired}>
        <span>
          Your company is read-only. You can still view and export your records.{" "}
          {viewer === "owner" ? "Request an extension, or email " : "Email "}
          {email}.
        </span>
        {request}
      </TrialBannerBody>
    ) : null;
  return (
    <>
      <div
        role="status"
        aria-label="Trial status"
        className={`flex flex-wrap items-center gap-2 px-4 py-2 ${TONE[phase]}`}
      >
        <span aria-hidden="true">{ICON[phase]}</span>
        <strong>{trialIndicatorText(status, lastDay)}</strong>
      </div>
      {banner}
    </>
  );
}

function TrialBannerBody({
  tone,
  children,
}: {
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label="Trial"
      className={`flex flex-wrap items-center gap-3 p-4 ${tone}`}
    >
      {children}
    </section>
  );
}
