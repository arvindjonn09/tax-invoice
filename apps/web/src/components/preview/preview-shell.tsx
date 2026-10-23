import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { navLinksFor } from "@/server/shell";

/** Static M0 preview frame: owner navigation, design-preview banner, no data. */
export function PreviewShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      companyName="Sample Company A"
      roleLabel="Owner (sample)"
      navigation={navLinksFor("owner")}
      demoPresent={false}
      preview
    >
      {children}
    </AppShell>
  );
}

/** Specimen switcher: navigation between static samples is allowed. */
export function SpecimenNav({
  label,
  current,
  options,
}: {
  label: string;
  current: string;
  options: readonly { value: string; label: string; href: string }[];
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <a
          key={option.value}
          href={option.href}
          aria-current={option.value === current ? "page" : undefined}
          className={`min-h-11 rounded-sm border border-control-border px-4 py-2 underline ${
            option.value === current
              ? "bg-info font-semibold text-info-foreground"
              : ""
          }`}
        >
          {option.label}
        </a>
      ))}
    </nav>
  );
}

/** A labelled sample metric (no calculation, no comparison arrows). */
export function SampleMetric({
  label,
  basis,
  children,
  note,
}: {
  label: string;
  basis?: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border bg-card p-4 text-card-foreground">
      <p className="text-sm text-muted-foreground">
        {label}
        {basis ? ` · ${basis}` : ""}
      </p>
      <p className="text-[32px] leading-10 font-semibold tabular-nums">
        {children}
      </p>
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
