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
