import type { TrialStatus } from "@jobflow/domain";

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

const longDate = (day: string) =>
  new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/**
 * Persistent free-trial notice (S8). Owners, managers and accountants see the
 * countdown and end date; other roles only see that the trial has ended, with
 * no dates.
 */
export function TrialBanner({
  status,
  lastDay,
  showCountdown,
  supportEmail,
}: {
  status: TrialStatus;
  lastDay: string;
  showCountdown: boolean;
  supportEmail: string;
}) {
  const ends = longDate(lastDay);
  if (status.phase === "expired" && !showCountdown) {
    return (
      <section
        aria-label="Trial ended"
        className="flex flex-wrap items-center gap-2 border-b-2 border-danger-foreground bg-danger p-4 text-danger-foreground"
      >
        <span aria-hidden="true">⏱</span>
        <strong>This company&apos;s free trial has ended.</strong>
        <span>Contact your company owner.</span>
      </section>
    );
  }
  if (status.phase === "expired") {
    return (
      <section
        aria-label="Trial ended"
        className="flex flex-wrap items-center gap-2 border-b-2 border-danger-foreground bg-danger p-4 text-danger-foreground"
      >
        <span aria-hidden="true">⏱</span>
        <strong>Your free trial has ended.</strong>
        <span>
          It ended on {ends}. To keep using JobFlow, email{" "}
          <a className="underline" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
          .
        </span>
      </section>
    );
  }
  if (!showCountdown) return null;
  const urgent = status.phase !== "normal";
  return (
    <section
      aria-label="Free trial"
      className={
        urgent
          ? "flex flex-wrap items-center gap-2 border-b-2 border-warning-foreground bg-warning p-4 text-warning-foreground"
          : "flex flex-wrap items-center gap-2 border-b bg-info px-4 py-2 text-info-foreground"
      }
    >
      <span aria-hidden="true">⏱</span>
      <strong>
        {status.phase === "critical"
          ? "Last day of your free trial"
          : `Free trial: ${status.daysRemaining} days left`}
      </strong>
      <span>Ends {ends}.</span>
      {urgent ? (
        <span>
          To continue after that, email{" "}
          <a className="underline" href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
          .
        </span>
      ) : null}
    </section>
  );
}
